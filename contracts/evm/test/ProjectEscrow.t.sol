// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {ProjectEscrow, EscrowFactory, IERC20} from "../src/ProjectEscrow.sol";

interface Vm {
    function prank(address) external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function warp(uint256) external;
}

/// @dev Executable six-decimal test asset; failures model blocked USDC destinations.
contract TestDollar is IERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public blocked;

    function decimals() external pure returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function blockAddress(address who) external {
        blocked = who;
    }

    function approve(address who, uint256 amount) external returns (bool) {
        allowance[msg.sender][who] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        move(from, to, amount);
        return true;
    }

    function move(address from, address to, uint256 amount) private {
        require(to != blocked, "blocked");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

contract ProjectEscrowTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    TestDollar private dollar;
    ProjectEscrow private vault;
    address private constant ATTESTER = address(0xA11);
    address private constant FEE = address(0xFEE);
    address private constant ALICE = address(0xA1);
    address private constant BOB = address(0xB0B);
    address private constant REFUND = address(0x123);
    bytes32 private constant FIRST = bytes32(uint256(1));
    bytes32 private constant SECOND = bytes32(uint256(2));

    function setUp() public {
        dollar = new TestDollar();
        vault = new ProjectEscrow(bytes32("project"), dollar, address(this), REFUND, FEE, ATTESTER);
        dollar.mint(address(this), type(uint128).max);
        dollar.approve(address(vault), type(uint256).max);
    }

    function bind(uint64 actor, address destination, uint64 predecessor) private {
        vm.prank(ATTESTER);
        vault.bindDestination(actor, destination, predecessor, bytes32(uint256(actor)), uint64(block.timestamp + 100));
    }

    function assertEq(uint256 a, uint256 b) private pure {
        require(a == b, "amount mismatch");
    }

    function conservation() private view {
        uint256 remaining = vault.freeBalance() + vault.reservedPrincipal() + vault.reservedFees();
        require(dollar.balanceOf(address(vault)) == remaining, "reserve balance");
        require(
            vault.totalDeposited()
                == remaining + vault.totalPaid() + vault.totalPayoutFees() + vault.totalGrossWithdrawn(),
            "conservation"
        );
    }

    function testFullLifecycleLateWalletAndRefund() public {
        vault.deposit(1_000e6);
        vault.commitAward(FIRST, 101, 100e6, FIRST);
        vault.commitAward(SECOND, 202, 50e6, SECOND);
        bind(101, ALICE, 0);
        vm.prank(address(0x999));
        vault.pay(FIRST, 1);
        assertEq(dollar.balanceOf(ALICE), 98e6);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        vault.pay(SECOND, 0);
        vault.withdrawUnused(850e6);
        vm.expectRevert(ProjectEscrow.InsufficientFreeBalance.selector);
        vault.withdrawUnused(1);
        assertEq(dollar.balanceOf(REFUND), 765_000_000);
        bind(202, BOB, 0);
        vault.pay(SECOND, 1);
        assertEq(dollar.balanceOf(BOB), 49e6);
        assertEq(dollar.balanceOf(FEE), 88_000_000);
        assertEq(vault.totalPaid(), 147e6);
        assertEq(vault.totalPayoutFees(), 3e6);
        assertEq(vault.totalWithdrawalFees(), 85_000_000);
        vm.expectRevert(ProjectEscrow.InvalidInput.selector);
        vault.pay(SECOND, 1);
        conservation();
    }

    function testWalletRotationAndOrdering() public {
        vault.deposit(100e6);
        vault.commitAward(FIRST, 101, 100e6, FIRST);
        bind(101, ALICE, 0);
        bind(101, BOB, 1);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        vault.pay(FIRST, 1);
        vault.pay(FIRST, 2);
        bind(101, ALICE, 2);
        vm.expectRevert(ProjectEscrow.InvalidInput.selector);
        vault.pay(FIRST, 3);
        assertEq(dollar.balanceOf(ALICE), 0);
        assertEq(dollar.balanceOf(BOB), 98e6);
        conservation();
    }

    function testAuthorityAndReplay() public {
        vault.deposit(100e6);
        vm.prank(ATTESTER);
        vm.expectRevert(ProjectEscrow.Unauthorized.selector);
        vault.commitAward(FIRST, 1, 1, FIRST);
        vm.prank(ATTESTER);
        vm.expectRevert(ProjectEscrow.Unauthorized.selector);
        vault.withdrawUnused(1);
        vm.expectRevert(ProjectEscrow.Unauthorized.selector);
        vault.bindDestination(1, ALICE, 0, FIRST, uint64(block.timestamp + 100));
        vault.commitAward(FIRST, 1, 100e6, FIRST);
        vm.expectRevert(ProjectEscrow.DuplicateAward.selector);
        vault.commitAward(SECOND, 1, 1, FIRST);
        vm.expectRevert(ProjectEscrow.DuplicateAward.selector);
        vault.commitAward(FIRST, 1, 1, SECOND);
        bind(1, ALICE, 0);
        vm.prank(ATTESTER);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        vault.bindDestination(1, BOB, 0, SECOND, uint64(block.timestamp + 100));
        vm.warp(1000);
        vm.prank(ATTESTER);
        vm.expectRevert(ProjectEscrow.InvalidBinding.selector);
        vault.bindDestination(1, BOB, 1, SECOND, 999);
        conservation();
    }

    function testFeeTransferFailureRollsBackPrincipalAndPaidMarker() public {
        vault.deposit(100e6);
        vault.commitAward(FIRST, 1, 100e6, FIRST);
        bind(1, ALICE, 0);
        dollar.blockAddress(FEE);
        vm.expectRevert(ProjectEscrow.TransferFailed.selector);
        vault.pay(FIRST, 1);
        assertEq(dollar.balanceOf(ALICE), 0);
        assertEq(vault.totalPaid(), 0);
        conservation();
        dollar.blockAddress(address(0));
        vault.pay(FIRST, 1);
        conservation();
    }

    function testBlockedRecipientDoesNotBlockOtherAward() public {
        vault.deposit(200e6);
        vault.commitAward(FIRST, 1, 100e6, FIRST);
        vault.commitAward(SECOND, 2, 100e6, SECOND);
        bind(1, ALICE, 0);
        bind(2, BOB, 0);
        dollar.blockAddress(ALICE);
        vm.expectRevert(ProjectEscrow.TransferFailed.selector);
        vault.pay(FIRST, 1);
        vault.pay(SECOND, 1);
        assertEq(vault.reservedPrincipal(), 98e6);
        conservation();
    }

    function testFuzzSplitWithdrawalsPreserveFees(uint64 a, uint64 b) public {
        a = uint64(uint256(a) % 1e15 + 1);
        b = uint64(uint256(b) % 1e15 + 1);
        vault.deposit(a + b);
        vault.withdrawUnused(a);
        conservation();
        vault.withdrawUnused(b);
        assertEq(vault.totalWithdrawalFees(), (uint256(a) + b) / 10);
        conservation();
    }

    function testFuzzMixedLifecycleConservation(uint64 principal, uint64 unused, bool rotate) public {
        principal = uint64(uint256(principal) % 1e15 + 1);
        unused = uint64(uint256(unused) % 1e15 + 1);
        uint64 fee = vault.payoutFee(principal);
        vault.deposit(principal + unused);
        conservation();
        vault.commitAward(FIRST, 1, principal, FIRST);
        conservation();
        vault.withdrawUnused(unused);
        conservation();
        bind(1, ALICE, 0);
        if (rotate) bind(1, BOB, 1);
        vault.pay(FIRST, rotate ? 2 : 1);
        conservation();
        assertEq(dollar.balanceOf(rotate ? BOB : ALICE), principal - fee);
    }

    function testTinyAwardAndMaxGross() public {
        vault.deposit(1);
        vault.commitAward(FIRST, 1, 1, FIRST);
        bind(1, ALICE, 0);
        vault.pay(FIRST, 1);
        assertEq(dollar.balanceOf(ALICE), 1);
        assertEq(dollar.balanceOf(FEE), 0);
        conservation();
        uint64 remaining = type(uint64).max - 1;
        vault.deposit(remaining);
        vault.commitAward(SECOND, 1, remaining, SECOND);
        vault.pay(SECOND, 1);
        assertEq(vault.totalDeposited(), type(uint64).max);
        assertEq(vault.totalPaid() + vault.totalPayoutFees(), type(uint64).max);
        vm.expectRevert(abi.encodeWithSignature("Panic(uint256)", uint256(0x11)));
        vault.deposit(1);
        conservation();
    }

    function testFactoryUniqueProjectAndRegistrar() public {
        EscrowFactory factory = new EscrowFactory(dollar, FEE, ATTESTER);
        vm.prank(ALICE);
        vm.expectRevert(ProjectEscrow.Unauthorized.selector);
        factory.create(FIRST, address(this), REFUND);
        address created = factory.create(FIRST, address(this), REFUND);
        require(created == factory.vaults(FIRST), "registry");
        vm.expectRevert(ProjectEscrow.DuplicateAward.selector);
        factory.create(FIRST, address(this), REFUND);
    }
}
