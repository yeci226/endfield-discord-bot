import assert from "node:assert/strict";
import { validateTemplateImages } from "./templateGuard";

const ok = (t: unknown) =>
  assert.equal(validateTemplateImages(t).ok, true, JSON.stringify(t));
const bad = (t: unknown) =>
  assert.equal(validateTemplateImages(t).ok, false, JSON.stringify(t));

ok({});
ok(null);
ok({ background: { url: "illustrators/a.png" } });
ok({ background: { url: "https://bbs.hycdn.cn/a.png" } });
ok({ fabricJson: { objects: [{ type: "image", src: "/assets/ui/a.png" }] } });
ok({
  fabricJson: {
    objects: [
      {
        type: "image",
        src: "/api/proxy?url=" + encodeURIComponent("https://static.skport.com/a.png"),
      },
    ],
  },
});
ok({ fabricJson: { objects: [{ type: "text", text: "see http://evil.com" }] } });
ok({ base: { avatarUrl: "https://cdn.discordapp.com/avatars/1/a.png" } });
ok({ fabricJson: { objects: [{ type: "image", src: "data:image/png;base64,AAAA" }] } });

// SSRF
bad({ background: { url: "http://127.0.0.1:3838/x" } });
bad({ background: { url: "https://evil.com/a.png" } });
bad({ background: { url: "https://169.254.169.254/latest/meta-data" } });
bad({ fabricJson: { objects: [{ type: "image", src: "https://evil.com/a.png" }] } });
bad({
  fabricJson: {
    objects: [
      { type: "image", src: "/api/proxy?url=" + encodeURIComponent("http://localhost/x") },
    ],
  },
});
bad({
  fabricJson: {
    objects: [
      { type: "image", src: "/api/proxy?url=" + encodeURIComponent("https://evil.com/x.png") },
    ],
  },
});
bad({ base: { avatarUrl: "https://skport.com@evil.com/a.png" } });
// nested inside groups, arrays and a JSON-string fabricJson
bad({ fabricJson: { objects: [{ objects: [{ src: "https://evil.com/a.png" }] }] } });
bad({
  fabricJson: JSON.stringify({ objects: [{ type: "image", src: "http://10.0.0.1/a" }] }),
});
// local file escape
bad({ background: { url: "../../.env" } });
bad({ fabricJson: { objects: [{ type: "image", src: "/../../secret.png" }] } });
bad({ background: { url: "..\\..\\x.png" } });
bad({ background: { url: "file:///etc/passwd" } });
bad({ background: { url: "C:/Windows/win.ini" } });
bad({ background: { url: "//evil.com/a.png" } });

// depth bomb
{
  let t: any = { src: "x.png" };
  for (let i = 0; i < 100; i++) t = { a: t };
  bad(t);
}

console.log("templateGuard tests passed");
