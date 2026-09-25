import DOMPurify from "dompurify";
/** Model/tool output is untrusted. Block active HTML and passive network loads. */
export function sanitizeContent(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true, mathMl: true },
    FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "iframe", "object", "embed", "img", "image", "audio", "video", "source", "link", "meta", "foreignObject", "use", "feImage", "animate", "animateMotion", "animateTransform", "set"],
    FORBID_ATTR: ["style", "src", "srcset", "poster", "background", "xlink:href"],
    SANITIZE_NAMED_PROPS: true,
  });
}
