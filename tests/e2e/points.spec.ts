import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { archivedPaidCycleIndex, snapshotFixture } from "../fixtures";

test(
  "points history is usable, accessible and independent of payments",
  { tag: ["@pages"] },
  async ({ page }, info) => {
    const errors: string[] = [];
    const failures: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("response", (r) => {
      if (
        new URL(r.url()).origin === new URL(page.url()).origin &&
        r.status() >= 400
      )
        failures.push(`${r.status()} ${r.url()}`);
    });
    const response = await page.goto("/points");
    expect(response?.status()).toBe(200);
    const reloaded = await page.reload();
    expect(reloaded?.status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: "Slop Points", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Sort by")).toHaveValue("score");
    await page.getByLabel("Period", { exact: true }).selectOption("lifetime");
    await expect(page.getByRole("table")).toBeVisible({ timeout: 30000 });
    await expect(
      page.getByRole("columnheader", { name: "Slop Score", exact: true }),
    ).toBeVisible();
    await page.getByLabel("Sort by").selectOption("money");
    await expect(page).toHaveURL(/sort=money/);
    await page.reload();
    await expect(page.getByLabel("Sort by")).toHaveValue("money");
    await expect(page.getByLabel("Period", { exact: true })).toHaveValue(
      "lifetime",
    );
    await page.getByLabel("Sort by").selectOption("points");
    await expect(page.getByText(/Points have no monetary value/)).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Contributor directory" })
        .getByText(/^[\d,]+ contributors$/),
    ).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.getByLabel("Period", { exact: true }).selectOption("lifetime");
    const first = page.getByRole("table").getByRole("row").nth(1);
    const login = await first.getByRole("link").innerText();
    await page.getByLabel("Find a contributor").fill(login);
    await expect(
      page.getByRole("table").getByRole("link", { name: login, exact: true }),
    ).toBeVisible();
    await page
      .getByLabel("Find a contributor")
      .fill("no-such-contributor-987654321");
    await expect(
      page.getByText("No recorded contributions match this view."),
    ).toBeVisible();
    await page.getByLabel("Find a contributor").fill("");
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByText(/Page 2 of/)).toBeVisible();
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() => document.activeElement !== document.body),
    ).toBe(true);
    const accessibility = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(accessibility.violations).toEqual([]);
    await page.screenshot({
      path: info.outputPath("points.png"),
      fullPage: true,
    });
    // Match the repository's 200% text-enlargement fixture without reducing
    // a 320px viewport below the supported reflow width through CSS zoom.
    await page.evaluate(() => {
      const typography = [...document.querySelectorAll<HTMLElement>("body *")]
        .filter((el) => el instanceof HTMLElement)
        .map((el) => ({
          el,
          font: getComputedStyle(el).fontSize,
          line: getComputedStyle(el).lineHeight,
        }));
      for (const { el, font, line } of typography) {
        el.style.fontSize = `${Number.parseFloat(font) * 2}px`;
        if (line !== "normal")
          el.style.lineHeight = `${Number.parseFloat(line) * 2}px`;
      }
    });
    expect(
      await page.evaluate(() => {
        const overflow =
          document.documentElement.scrollWidth > window.innerWidth + 1;
        return {
          overflow,
          elements: !overflow
            ? []
            : [...document.querySelectorAll("main *")]
                .filter(
                  (el) =>
                    el.getBoundingClientRect().right > window.innerWidth + 1,
                )
                .map((el) => ({
                  tag: el.tagName,
                  class: el.className,
                  text: el.textContent?.slice(0, 80),
                  right: el.getBoundingClientRect().right,
                })),
        };
      }),
    ).toEqual({ overflow: false, elements: [] });
    await page.screenshot({
      path: info.outputPath("points-zoom.png"),
      fullPage: true,
    });
    expect(errors).toEqual([]);
    expect(failures).toEqual([]);
  },
);

test("ranks archived work separately from the month its payment settled", async ({
  page,
}) => {
  // Local public-record fixtures exercise the browser projection, not chain verification.
  await page.clock.setFixedTime(new Date("2026-08-17T12:00:00.000Z"));
  await page.route("**/data/leaderboard.json?**", (route) =>
    route.fulfill({ json: snapshotFixture() }),
  );
  await page.route("**/data/cycles/index.json?**", (route) =>
    route.fulfill({ json: archivedPaidCycleIndex() }),
  );
  await page.goto("/?sort=money#leaderboard");
  const standings = page.getByRole("region", {
    name: "Leaderboard",
    exact: true,
  });
  const recipient = standings.getByRole("row").filter({
    has: page.getByRole("link", { name: "archive-only", exact: true }),
  });
  await expect(recipient.locator("td").nth(4)).toHaveText("$1");
  await expect(recipient.locator("td").nth(2)).toHaveText("Unavailable");
  await standings
    .getByLabel("Period", { exact: true })
    .selectOption("lifetime");
  await standings.getByLabel("Sort by").selectOption("score");
  await expect(recipient.locator("td").nth(2)).toHaveText("7");
  await expect(recipient.locator("td").nth(4)).toHaveText("$1");
  await page.clock.setFixedTime(new Date("2026-07-31T12:00:00.000Z"));
  await page.goto("/?sort=money#leaderboard");
  await expect(recipient.locator("td").nth(2)).toHaveText("7");
  await expect(recipient.locator("td").nth(4)).toHaveText("$0");
});
