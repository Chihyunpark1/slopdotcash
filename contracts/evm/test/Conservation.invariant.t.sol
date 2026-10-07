// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {ProjectEscrow} from "../src/ProjectEscrow.sol";
import {TestDollar, Vm} from "./ProjectEscrow.t.sol";

contract EscrowHandler {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    TestDollar public immutable dollar;
    ProjectEscrow public immutable vault;
    address private constant ATTESTER = address(0xA11);
    uint64 public nextId = 1;

    constructor() {
        dollar = new TestDollar();
        vault = new ProjectEscrow(bytes32("invariant"), dollar, address(this), address(0x123), address(0xFEE), ATTESTER);
        dollar.approve(address(vault), type(uint256).max);
    }

    function deposit(uint64 input) external {
        uint64 amount = input % 1e12 + 1;
        dollar.mint(address(this), amount);
        vault.deposit(amount);
    }

    function commit(uint64 input) external {
        uint64 amount = input % 1e10 + 1;
        if (amount > vault.freeBalance()) return;
        uint64 id = nextId++;
        vault.commitAward(bytes32(uint256(id)), id, amount, bytes32(uint256(id)));
    }

    function bindOrRotate(uint64 input) external {
        if (nextId == 1) return;
        uint64 id = input % (nextId - 1) + 1;
        (, uint64 version,) = vault.bindings(id);
        vm.prank(ATTESTER);
        vault.bindDestination(
            id,
            address(uint160(0x10000 + uint256(id) + uint256(version) * 10000)),
            version,
            bytes32(uint256(id)),
            uint64(block.timestamp + 100)
        );
    }

    function pay(uint64 input) external {
        if (nextId == 1) return;
        uint64 id = input % (nextId - 1) + 1;
        (, uint64 version,) = vault.bindings(id);
        (,,,, bool paid) = vault.awards(bytes32(uint256(id)));
        if (version == 0 || paid) return;
        vault.pay(bytes32(uint256(id)), version);
    }

    function withdraw(uint64 input) external {
        uint256 free = vault.freeBalance();
        if (free == 0) return;
        vault.withdrawUnused(uint64(uint256(input) % free + 1));
    }
}

contract ConservationInvariantTest {
    EscrowHandler private handler;

    function setUp() public {
        handler = new EscrowHandler();
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariantConservationAndFeeAccounting() public view {
        ProjectEscrow vault = handler.vault();
        uint256 remaining = vault.freeBalance() + vault.reservedPrincipal() + vault.reservedFees();
        require(handler.dollar().balanceOf(address(vault)) == remaining, "reserve balance");
        require(
            vault.totalDeposited()
                == remaining + vault.totalPaid() + vault.totalPayoutFees() + vault.totalGrossWithdrawn(),
            "conservation"
        );
        require(vault.totalWithdrawalFees() == vault.totalGrossWithdrawn() / 10, "withdrawal fee");
        uint256 unpaidPrincipal;
        uint256 unpaidFees;
        uint256 paidPrincipal;
        uint256 paidFees;
        for (uint64 id = 1; id < handler.nextId(); id++) {
            (uint64 actor, uint64 principal, uint64 fee, bytes32 source, bool paid) = vault.awards(bytes32(uint256(id)));
            require(actor == id && source == bytes32(uint256(id)), "immutable award identity");
            require(vault.consumedSources(source), "origin remains consumed");
            if (paid) {
                paidPrincipal += principal - fee;
                paidFees += fee;
            } else {
                unpaidPrincipal += principal - fee;
                unpaidFees += fee;
            }
        }
        require(
            unpaidPrincipal == vault.reservedPrincipal() && unpaidFees == vault.reservedFees(),
            "every unpaid award reserved"
        );
        require(paidPrincipal == vault.totalPaid() && paidFees == vault.totalPayoutFees(), "paid counters match awards");
    }
}
