import { describe, expect, it } from "vitest";
import { sanitizeContent } from "../sanitize";
describe("untrusted output", () => {
  it("removes event handlers, executable links, forms, and remote resource loads", () => {
    const dirty = '<img src="https://evil.test/?secret=fixture" onerror="alert(1)"><script>alert(1)</script><a href="javascript:alert(1)">click</a><form action="https://evil.test"><input></form><div style="background:url(https://evil.test)">ok</div>';
    const root = document.createElement("div"); root.innerHTML = sanitizeContent(dirty);
    expect(root.querySelector("img,script,form,input,[style],[onerror],[href]")).toBeNull();
    expect(root.textContent).toContain("ok");
  });
  it("keeps ordinary text, code, tables and HTTPS links", () => {
    const safe = '<table><tbody><tr><td>cell</td></tr></tbody></table><pre><code>&lt;script&gt;</code></pre><a href="https://example.com/docs">Docs</a>';
    const root = document.createElement("div"); root.innerHTML = sanitizeContent(safe);
    expect(root.querySelector("td")?.textContent).toBe("cell");
    expect(root.querySelector("code")?.textContent).toBe("<script>");
    expect(root.querySelector("a")?.getAttribute("href")).toBe("https://example.com/docs");
  });
  it("strips active SVG and embedded HTML", () => {
    const html = sanitizeContent('<svg onload="alert(1)"><foreignObject><iframe src="https://evil.test"></iframe></foreignObject><image href="https://evil.test"/><circle cx="10" cy="10" r="5"/></svg>');
    expect(html).not.toMatch(/onload|foreignObject|iframe|image|evil/);
    expect(html).toContain("circle");
  });
});
