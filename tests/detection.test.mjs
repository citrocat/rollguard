import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const sandbox = {
  console,
  URL,
  URLSearchParams,
  Date,
  Math,
  String,
  Object,
  Set,
  Map,
  Intl,
};
vm.createContext(sandbox);
for (const file of ["extension/shared/config.js", "extension/shared/detection.js"]) {
  vm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file });
}

const D = sandbox.RollGuardDetect;
const C = sandbox.RollGuardConfig;
assert.ok(D, "detection API available");
assert.ok(C, "config API available");
assert.equal(D.SEED_VIDEOS.length, 3);

const cases = [
  ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3s", "dQw4w9WgXcQ"],
  ["https://youtu.be/dQw4w9WgXcQ?si=abc", "dQw4w9WgXcQ"],
  ["https://m.youtube.com/watch?feature=share&v=oHg5SJYRHA0", "oHg5SJYRHA0"],
  ["https://music.youtube.com/watch?v=ceRfyROxeJQ", "ceRfyROxeJQ"],
  ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ["https://www.youtube-nocookie.com/embed/oHg5SJYRHA0", "oHg5SJYRHA0"],
  ["https://www.youtube.com/live/ceRfyROxeJQ?feature=share", "ceRfyROxeJQ"],
];
for (const [url, id] of cases) {
  assert.equal(D.getVideoId(url), id, `video ID for ${url}`);
}

assert.equal(D.getVideoId("https://example.com/watch?v=dQw4w9WgXcQ"), null);
assert.equal(D.getVideoId("https://www.youtube.com/watch?v=short"), null);
assert.equal(D.getVideoId("not a url"), null);

assert.equal(D.isKnownVideo("dQw4w9WgXcQ"), true);
assert.equal(D.isKnownVideo("LLFhKaqnWwk"), true);
assert.equal(D.isKnownVideo("3BFTio5296w"), true);
assert.equal(D.isKnownVideo("2rmYU0B3kCQ"), true);
assert.equal(D.isKnownVideo("-aIiQj79b6Q"), true);
assert.equal(D.isKnownVideo("iNTeY4hFwNU"), true);
assert.equal(D.getSeedVideo("LLFhKaqnWwk")?.title, "Rick Astley - Never Gonna Give You Up (Official Animated Video)");
assert.equal(D.isKnownVideo("aaaaaaaaaaa"), false);
assert.equal(D.abbreviatedLink("dQw4w9WgXcQ"), "youtu.be/dQw4…XcQ");
assert.equal(D.hostOf("https://www.Example.com/foo"), "example.com");

const short = D.parseLink("https://bit.ly/3xR1ck");
assert.equal(short.isShortener, true);
assert.equal(short.isYouTube, false);

assert.equal(D.classifyVideo({ videoId: "dQw4w9WgXcQ" })?.reason, "known");
assert.equal(
  D.classifyVideo({
    videoId: "AbCdEfGhIjK",
    title: "Rick Astley - Never Gonna Give You Up (Official Video)",
    channel: "Some Uploader",
  })?.reason,
  "title"
);
assert.equal(
  D.classifyVideo({
    videoId: "AbCdEfGhIjK",
    title: "Never Gonna Give You Up",
    channel: "Random Uploads",
  })?.reason,
  "title"
);
assert.equal(
  D.classifyVideo({
    videoId: "AbCdEfGhIjK",
    title: "VICE interviews Rick Astley about Never Gonna Give You Up",
    channel: "VICE",
  }),
  null
);
assert.equal(
  D.classifyVideo({
    videoId: "AbCdEfGhIjK",
    title: "Never Gonna Give You Up (Instrumental)",
    channel: "Rick Astley - Topic",
  }),
  null
);
assert.equal(
  D.classifyVideo({
    videoId: "AbCdEfGhIjK",
    title: "A completely unrelated video",
    channel: "Rick Astley",
  }),
  null
);

assert.equal(D.titleIsSong("Never Gonna Give You Up (Official Video)"), true);
assert.equal(D.titleIsSong("Never Gonna Give You Up but every line..."), false);
assert.equal(D.reasonLabel("known"), "热门样本命中");
assert.equal(D.formatRelativeTime(Date.now() - 5000), "刚刚");

console.log(`RollGuard detection tests passed (${cases.length + 14} assertions).`);
