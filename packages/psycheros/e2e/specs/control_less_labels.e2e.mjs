/**
 * WCAG 1.3.1 / 4.1.2: captions that used to be control-less <label> elements
 * are now plain elements, and the matching class selector keeps their
 * typography identical to the field labels beside them.
 */
import { launch, makeReport, openChat } from "../lib/harness.mjs";

const report = makeReport("Control-less captions");
const browser = await launch();
try {
  const page = await browser.newPage();
  await openChat(page);

  const cases = [
    {
      path: "/fragments/settings/sa",
      heading: ".llm-field-heading",
    },
    {
      path: "/fragments/settings/connections/discord",
      heading: ".llm-field-heading",
    },
    {
      path: "/fragments/settings/entity-core/graph",
      heading: ".gv-field-heading",
      extra: ["textTransform", "letterSpacing", "marginBottom"],
    },
    {
      path: "/fragments/settings/vision/anchors",
      heading: ".llm-field-heading",
    },
  ];

  for (const c of cases) {
    const result = await page.evaluate(async (item) => {
      document.getElementById("fragment-probe")?.remove();
      const host = document.createElement("div");
      host.id = "fragment-probe";
      const html = await (await fetch(item.path)).text();
      host.innerHTML = html;
      document.body.appendChild(host);
      const heading = host.querySelector(item.heading);
      if (!heading) return { missingHeading: true };
      // Compare against the element this caption used to be: a plain <label>
      // in the same field container, styled only by the element selector.
      const ref = document.createElement("label");
      ref.textContent = "Reference caption";
      heading.parentElement.insertBefore(ref, heading);
      const style = (el) => {
        const cs = getComputedStyle(el);
        const out = {
          fontSize: cs.fontSize,
          color: cs.color,
          fontWeight: cs.fontWeight,
          display: cs.display,
        };
        for (const key of item.extra ?? []) out[key] = cs[key];
        return out;
      };
      const before = style(ref);
      const after = style(heading);
      ref.remove();
      const mismatch = Object.keys(before).filter((key) =>
        before[key] !== after[key]
      );
      return {
        tag: heading.tagName,
        text: (heading.textContent ?? "").trim().slice(0, 40),
        mismatch,
        before,
        after,
      };
    }, c);

    report.check(
      `${c.path} keeps the label typography`,
      result.tag === "DIV" && result.mismatch?.length === 0,
      JSON.stringify(result),
    );
  }
} finally {
  await browser.close();
}
report.done();
