/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { listAllWorkerDomains } from "./qualify-vetting-sandbox";

const worker = "slop-vetting-sandbox-staging";

// The qualification gate must see every worker domain, not just the first
// page: a domain on a later page is still a public domain, and missing it
// would let the gate pass while the sandbox is actually public.

describe("listAllWorkerDomains", () => {
  it("finds the sandbox worker on a later page", async () => {
    const pages = [
      [{ service: "other-worker-a" }, { service: "other-worker-b" }],
      [{ service: worker }],
    ];
    const fetched: number[] = [];
    const domains = await listAllWorkerDomains(async (page) => {
      fetched.push(page);
      return { domains: pages[page - 1] ?? [], totalPages: pages.length };
    });
    expect(fetched).toEqual([1, 2]);
    expect(domains.some((d) => d.service === worker)).toBe(true);
  });

  it("stops after a single page when there is only one", async () => {
    const fetched: number[] = [];
    const domains = await listAllWorkerDomains(async (page) => {
      fetched.push(page);
      return { domains: [{ service: "other-worker" }], totalPages: 1 };
    });
    expect(fetched).toEqual([1]);
    expect(domains.some((d) => d.service === worker)).toBe(false);
  });

  it("reads one page when total_pages is absent", async () => {
    const fetched: number[] = [];
    const domains = await listAllWorkerDomains(async (page) => {
      fetched.push(page);
      return { domains: [], totalPages: 1 };
    });
    expect(fetched).toEqual([1]);
    expect(domains).toEqual([]);
  });
});
