// The Compile service against a GitHub of its own (this file's), with no network: node --test.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, createHash, generateKeyPairSync, verify } from "node:crypto";
import worker, { jobOf, seal, repoOf, modJobOf, askOf, modsTag, PER_ADDRESS, MAX_BODY } from "../src/index.js";

const REPO = "starling-client/mod-builds";
const COMMIT = "ac874422ed8f892505ff73d67ae486ecfee7a516";

/** The cache of one Cloudflare location: what was put, until its max-age. */
class Cache {
  entries = new Map();
  clock = 0;
  async match(request) {
    const entry = this.entries.get(request.url);
    if (!entry || entry.until <= this.clock) return undefined;
    return new Response(entry.body);
  }
  async put(request, response) {
    const age = Number(/max-age=(\d+)/.exec(response.headers.get("Cache-Control"))[1]);
    this.entries.set(request.url, { body: await response.text(), until: this.clock + age });
  }
}

/** GitHub as the service sees it: its releases, the workflows' runs, versions.json. */
class GitHub {
  assets = { requests: new Map(), results: new Map() };
  // When each asset came, by "tag/name", for the releases' asset lists.
  created = new Map();
  runs = [];
  // mod.yml's runs, apart from build.yml's.
  modRuns = [];
  dispatched = [];
  modDispatched = [];
  deleted = [];
  calls = 0;
  async fetch(input, init = {}) {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = init.method ?? "GET";
    const json = (code, body) => new Response(JSON.stringify(body), { status: code });
    if (url.href === `https://raw.githubusercontent.com/${this.repo}/main/versions.json`) {
      return json(200, { "0.8.0": COMMIT, "0.9.0-preview.cac7bf6459": "cac7bf64590fb38b4badee90f1f09848ce7f8daa" });
    }
    const download = url.href.match(new RegExp(`^https://github.com/${this.repo}/releases/download/([\\w-]+)/(.+)$`));
    if (download) {
      const bytes = this.assets[download[1]]?.get(download[2]);
      if (!bytes) return new Response("Not Found", { status: 404 });
      // A download is GitHub's redirect to where the file is; followed, the file.
      if (init.redirect === "manual") return new Response(null, { status: 302, headers: { Location: "https://objects.example/x" } });
      return new Response(method === "HEAD" ? null : bytes);
    }
    this.calls++;
    if (url.pathname.startsWith("/app/")) return this.app(url, method, init);
    assert.equal(init.headers?.Authorization, `Bearer ${this.token}`, "every API call carries the token");
    const tags = Object.keys(this.assets);
    if (url.host === "uploads.github.com") {
      const tag = tags[Number(url.pathname.split("/")[5]) - 1];
      const name = url.searchParams.get("name");
      if (this.assets[tag].has(name)) {
        return json(422, { message: "Validation Failed", errors: [{ resource: "ReleaseAsset", code: "already_exists", field: "name" }] });
      }
      this.assets[tag].set(name, new Uint8Array(await new Response(init.body).arrayBuffer()));
      this.created.set(`${tag}/${name}`, new Date().toISOString());
      return json(201, {});
    }
    if (!url.pathname.startsWith(`/repos/${this.repo}/`)) return json(404, { message: "Not Found" });
    const path = url.pathname.replace(`/repos/${this.repo}`, "");
    const tag = /^\/releases\/tags\/(.+)$/.exec(path)?.[1];
    if (tag && tags.includes(tag)) return json(200, { id: tags.indexOf(tag) + 1 });
    const listed = /^\/releases\/(\d+)\/assets$/.exec(path);
    if (method === "GET" && listed) {
      const of = tags[Number(listed[1]) - 1];
      const page = Number(url.searchParams.get("page") ?? 1);
      const all = [...this.assets[of].keys()].map((name, i) => ({
        id: Number(listed[1]) * 1000 + i,
        name,
        created_at: this.created.get(`${of}/${name}`) ?? new Date().toISOString(),
      }));
      return json(200, page === 1 ? all : []);
    }
    const asset = /^\/releases\/assets\/(\d+)$/.exec(path);
    if (method === "DELETE" && asset) {
      const id = Number(asset[1]);
      const of = tags[Math.floor(id / 1000) - 1];
      const name = [...this.assets[of].keys()][id % 1000];
      this.assets[of].delete(name);
      this.deleted.push(`${of}/${name}`);
      return new Response(null, { status: 204 });
    }
    for (const [workflow, dispatched, runs] of [
      ["build.yml", this.dispatched, this.runs],
      ["mod.yml", this.modDispatched, this.modRuns],
    ]) {
      if (method === "POST" && path === `/actions/workflows/${workflow}/dispatches`) {
        dispatched.push(JSON.parse(init.body));
        return new Response(null, { status: 204 });
      }
      if (path === `/actions/workflows/${workflow}/runs`) {
        const status = url.searchParams.get("status");
        const page = Number(url.searchParams.get("page") ?? 1);
        return json(200, { workflow_runs: page === 1 ? runs.filter((r) => !status || r.status === status) : [] });
      }
    }
    return json(404, { message: "Not Found" });
  }

  /** The GitHub App's own calls: signed with its key, they give the installation's token. */
  app(url, method, init) {
    const json = (code, body) => new Response(JSON.stringify(body), { status: code });
    const [head, claims, signature] = init.headers.Authorization.replace("Bearer ", "").split(".");
    const signed = verify("RSA-SHA256", Buffer.from(`${head}.${claims}`), appKeys.publicKey, Buffer.from(signature, "base64url"));
    const { iat, exp, iss } = JSON.parse(Buffer.from(claims, "base64url"));
    if (!signed || iss !== "5775282" || exp - iat > 600) return json(401, { message: "Bad credentials" });
    if (method === "GET" && url.pathname === "/app/installations") {
      return json(200, [
        { id: 12, account: { login: "someone-else" } },
        { id: 77, account: { login: "starling-client" } },
      ]);
    }
    if (method === "POST" && url.pathname === "/app/installations/77/access_tokens") {
      this.minted++;
      return json(201, { token: "ghs_test", expires_at: new Date(Date.now() + 3600e3).toISOString() });
    }
    return json(404, { message: "Not Found" });
  }
  token = "secret";
  minted = 0;
  // The repository this GitHub has: the service's own, or a fork's.
  repo = REPO;
}

const appKeys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

let github, cache, waiting;
// No hold in the tests but the one that tests it.
const env = { GITHUB_TOKEN: "secret", HOLD_MS: 0 };
const ctx = { waitUntil: (p) => waiting.push(p) };

beforeEach(() => {
  github = new GitHub();
  cache = new Cache();
  waiting = [];
  globalThis.fetch = (input, init) => github.fetch(input, init);
  globalThis.caches = { default: cache };
});

async function call(method, path, { body, address = "203.0.113.7", as = env } = {}) {
  const response = await worker.fetch(
    new Request(`https://starling-compile.example${path}`, {
      method,
      body,
      headers: { "CF-Connecting-IP": address },
    }),
    as,
    ctx,
  );
  await Promise.all(waiting.splice(0));
  return response;
}

const mods = new TextEncoder().encode("the player's mods ".repeat(100));

test("new mods are sealed, kept under a random name and built", async () => {
  const response = await call("POST", "/v1/build?version=0.8.0", { body: mods });
  assert.equal(response.status, 200);
  const { job } = await response.json();
  assert.equal(job, await jobOf("0.8.0", COMMIT, mods));
  assert.equal(github.dispatched.length, 1);
  const { ref, inputs } = github.dispatched[0];
  assert.equal(ref, "main");
  assert.deepEqual(Object.keys(inputs).sort(), ["ask", "job", "key", "version"]);
  assert.equal(inputs.job, job);
  assert.equal(inputs.version, "0.8.0");
  assert.match(inputs.ask, /^[0-9a-f]{32}$/);
  assert.match(inputs.key, /^[0-9a-f]{96}$/);
  const sealed = github.assets.requests.get(`${inputs.ask}.bin`);
  assert.ok(sealed, "the sealed mods are in the requests release");
  assert.notDeepEqual(sealed, mods);
  // As the build opens them: openssl enc -d -aes-256-ctr -K <64 hex> -iv <32 hex>.
  const opened = createDecipheriv(
    "aes-256-ctr",
    Buffer.from(inputs.key.slice(0, 64), "hex"),
    Buffer.from(inputs.key.slice(64), "hex"),
  );
  assert.deepEqual(new Uint8Array(Buffer.concat([opened.update(sealed), opened.final()])), mods);
});

test("the job is the build's own check: sha256 of what was asked and the mods", async () => {
  const asked = `/v1/build?version=0.8.0&commit=${COMMIT}`;
  const want = createHash("sha256").update(asked).update(mods).digest("hex").slice(0, 24);
  assert.equal(await jobOf("0.8.0", COMMIT, mods), want);
});

test("a long body still opens: the counter never carries past its low 64 bits", async () => {
  const big = new Uint8Array(1 << 20).map((_, i) => i * 7);
  const { sealed, key } = await seal(big);
  const opened = createDecipheriv("aes-256-ctr", Buffer.from(key.slice(0, 64), "hex"), Buffer.from(key.slice(64), "hex"));
  assert.deepEqual(new Uint8Array(Buffer.concat([opened.update(sealed), opened.final()])), big);
});

test("the same mods asked again while they build start nothing new", async () => {
  await call("POST", "/v1/build?version=0.8.0", { body: mods });
  const again = await call("POST", "/v1/build?version=0.8.0", { body: mods });
  assert.equal(again.status, 200);
  assert.equal(github.dispatched.length, 1);
  assert.equal(github.assets.requests.size, 1);
});

test("mods built before are the same job, and nothing is built", async () => {
  const job = await jobOf("0.8.0", COMMIT, mods);
  const done = { state: "done", sha256: "a".repeat(64), size: 1234, build: { abi: "arm64-v8a" } };
  github.assets.results.set(`${job}.json`, new TextEncoder().encode(JSON.stringify(done)));
  const response = await call("POST", "/v1/build?version=0.8.0", { body: mods });
  assert.deepEqual(await response.json(), { job, repo: REPO });
  assert.equal(github.dispatched.length, 0);
  assert.equal(github.calls, 0, "no call to GitHub's API");
  const status = await call("GET", `/v1/job/${job}`);
  assert.deepEqual(await status.json(), done);
});

test("a job on its way says it builds, and the library is GitHub's download", async () => {
  const { job } = await (await call("POST", "/v1/build?version=0.8.0", { body: mods })).json();
  const status = await (await call("GET", `/v1/job/${job}`)).json();
  assert.equal(status.state, "queued", "just asked: in line until GitHub lists its run");
  assert.ok(Number.isInteger(status.ahead), "a whole place, as the game reads it");
});

test("a build in its shard release is found before the old results release", async () => {
  const job = "7123456789abcdef01234567";
  const done = { state: "done", sha256: "b".repeat(64), size: 4, build: {} };
  github.assets["results-7"] = new Map([
    [`${job}.json`, new TextEncoder().encode(JSON.stringify(done))],
    [`${job}.so`, new Uint8Array([1, 2, 3, 4])],
  ]);
  assert.deepEqual(await (await call("GET", `/v1/job/${job}`)).json(), done);
  const lib = await worker.fetch(
    new Request(`https://starling-compile.example/v1/job/${job}/lib`, { headers: { Range: "bytes=0-" } }),
    env,
    ctx,
  );
  assert.deepEqual(new Uint8Array(await lib.arrayBuffer()), new Uint8Array([1, 2, 3, 4]));
  const resumed = await worker.fetch(
    new Request(`https://starling-compile.example/v1/job/${job}/lib`, { headers: { Range: "bytes=2-" } }),
    env,
    ctx,
  );
  assert.equal(resumed.headers.get("Location"), `https://github.com/${REPO}/releases/download/results-7/${job}.so`);
});

test("a library from the start is a 200 the game can write; one that goes on is GitHub's 206", async () => {
  const job = "0123456789abcdef01234567";
  const library = new Uint8Array(4096).map((_, i) => i % 251);
  github.assets.results.set(`${job}.so`, library);
  // 0.8.0 asks with bytes=0- and appends on a 206: the first answer has to be a 200, whole.
  for (const range of ["bytes=0-", null]) {
    const response = await worker.fetch(
      new Request(`https://starling-compile.example/v1/job/${job}/lib`, {
        headers: range ? { Range: range } : {},
      }),
      env,
      ctx,
    );
    assert.equal(response.status, 200, `Range ${range}`);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), library);
  }
  const resumed = await worker.fetch(
    new Request(`https://starling-compile.example/v1/job/${job}/lib`, { headers: { Range: "bytes=1000-" } }),
    env,
    ctx,
  );
  assert.equal(resumed.status, 302);
  assert.equal(resumed.headers.get("Location"), `https://github.com/${REPO}/releases/download/results/${job}.so`);
  const missing = await call("GET", "/v1/job/ffffffffffffffffffffffff/lib");
  assert.equal(missing.status, 404);
});

test("a job on its way is told after a hold, so every game asks less often; a failure at once", async () => {
  const { job } = await (await call("POST", "/v1/build?version=0.8.0", { body: mods })).json();
  env.HOLD_MS = 300;
  try {
    let started = Date.now();
    assert.equal((await (await call("GET", `/v1/job/${job}`)).json()).state, "queued");
    assert.ok(Date.now() - started >= 290, "held");
    const failed = { state: "failed", error: "error[E0425]", settled: true, at: Date.now() / 1000 + 60 };
    github.assets.results.set(`${job}.failed.json`, new TextEncoder().encode(JSON.stringify(failed)));
    cache.entries.clear();
    started = Date.now();
    assert.equal((await (await call("GET", `/v1/job/${job}`)).json()).state, "failed");
    assert.ok(Date.now() - started < 290, "not held");
  } finally {
    env.HOLD_MS = 0;
  }
});

test("a hold ends when a look finds the answer, done or failed", async () => {
  const { job } = await (await call("POST", "/v1/build?version=0.8.0", { body: mods })).json();
  env.HOLD_MS = 5000;
  env.LOOK_MS = 100;
  const lands = (name, body) =>
    setTimeout(() => {
      github.assets.results.set(name, new TextEncoder().encode(JSON.stringify(body)));
      cache.entries.clear();
    }, 250);
  try {
    let started = Date.now();
    lands(`${job}.json`, { state: "done", sha256: "a".repeat(64), size: 3, build: null });
    assert.equal((await (await call("GET", `/v1/job/${job}`)).json()).state, "done");
    assert.ok(Date.now() - started < 2000, "told once it was there");

    const other = new TextEncoder().encode("other mods ".repeat(100));
    const second = (await (await call("POST", "/v1/build?version=0.8.0", { body: other })).json()).job;
    started = Date.now();
    lands(`${second}.failed.json`, { state: "failed", error: "error[E0425]", settled: true, at: Date.now() / 1000 + 60 });
    assert.equal((await (await call("GET", `/v1/job/${second}`)).json()).state, "failed");
    assert.ok(Date.now() - started < 2000, "told once it failed");
  } finally {
    env.HOLD_MS = 0;
    delete env.LOOK_MS;
  }
});

test("a run seen on GitHub from another location is queued or building", async () => {
  const job = "0123456789abcdef01234567";
  github.runs = [{ display_title: `build ${job}`, status: "queued", created_at: "2026-11-15T20:00:00Z" }];
  assert.deepEqual(await (await call("GET", `/v1/job/${job}`)).json(), { state: "queued", ahead: 0 });
  cache.clock += 130;
  github.runs = [{ display_title: `build ${job}`, status: "in_progress", run_started_at: new Date().toISOString() }];
  assert.equal((await (await call("GET", `/v1/job/${job}`)).json()).state, "building");
});

test("a job in line is told its place, from one look at the line for everyone", async () => {
  const at = (minute) => `2026-11-15T20:${String(minute).padStart(2, "0")}:00Z`;
  const jobs = ["aaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbb", "cccccccccccccccccccccccc"];
  // Listed newest first, as GitHub does.
  github.runs = [
    { display_title: `build ${jobs[2]}`, status: "queued", created_at: at(3) },
    { display_title: `build ${jobs[1]}`, status: "queued", created_at: at(2) },
    { display_title: `build ${jobs[0]}`, status: "queued", created_at: at(1) },
  ];
  const before = github.calls;
  for (const [i, job] of jobs.entries()) {
    assert.deepEqual(await (await call("GET", `/v1/job/${job}`)).json(), { state: "queued", ahead: i });
  }
  assert.equal(github.calls - before, 2, "one look at the line (queued and building) for all three");
  // A job that moved from waiting to building after the line was read is found by a new look,
  // not called lost.
  const moved = "dddddddddddddddddddddddd";
  github.runs.push({ display_title: `build ${moved}`, status: "in_progress", run_started_at: new Date().toISOString() });
  assert.equal((await (await call("GET", `/v1/job/${moved}`)).json()).state, "building");
  // Just asked and not listed yet: at the end of the line, not lost.
  const { job } = await (await call("POST", "/v1/build?version=0.8.0", { body: mods })).json();
  assert.deepEqual(await (await call("GET", `/v1/job/${job}`)).json(), { state: "queued", ahead: 3 });
});

test("a failure is told; one that may pass builds again when asked", async () => {
  const job = await jobOf("0.8.0", COMMIT, mods);
  const failed = { state: "failed", error: "GitHub's machine went away.", settled: false, at: Date.now() / 1000 + 5 };
  github.assets.results.set(`${job}.failed.json`, new TextEncoder().encode(JSON.stringify(failed)));
  const told = await (await call("GET", `/v1/job/${job}`)).json();
  assert.deepEqual(told, { state: "failed", error: "GitHub's machine went away.", settled: false });
  await call("POST", "/v1/build?version=0.8.0", { body: mods });
  assert.equal(github.dispatched.length, 1, "built again");
});

test("a failure for good is not built again", async () => {
  const job = await jobOf("0.8.0", COMMIT, mods);
  const failed = { state: "failed", error: "error[E0425]: cannot find value", settled: true, at: 1 };
  github.assets.results.set(`${job}.failed.json`, new TextEncoder().encode(JSON.stringify(failed)));
  const response = await call("POST", "/v1/build?version=0.8.0", { body: mods });
  assert.deepEqual(await response.json(), { job, repo: REPO });
  assert.equal(github.dispatched.length, 0);
});

test("an address has its builds a day", async () => {
  for (let i = 0; i < PER_ADDRESS; i++) {
    const body = new TextEncoder().encode(`mods ${i}`);
    assert.equal((await call("POST", "/v1/build?version=0.8.0", { body })).status, 200);
  }
  const over = await call("POST", "/v1/build?version=0.8.0", { body: new TextEncoder().encode("one more") });
  assert.equal(over.status, 429);
  assert.match((await over.json()).error, /tomorrow/);
  const other = await call("POST", "/v1/build?version=0.8.0", {
    body: new TextEncoder().encode("one more"),
    address: "198.51.100.2",
  });
  assert.equal(other.status, 200, "another address still builds");
});

test("what the service can't build is said in words the game shows", async () => {
  const old = await call("POST", "/v1/build?version=0.7.9", { body: mods });
  assert.equal(old.status, 400);
  assert.match((await old.json()).error, /Update Starling/);
  const wrong = await call("POST", "/v1/build?version=latest", { body: mods });
  assert.equal(wrong.status, 400);
  const empty = await call("POST", "/v1/build?version=0.8.0", { body: new Uint8Array() });
  assert.equal(empty.status, 413);
  const big = await call("POST", "/v1/build?version=0.8.0", { body: new Uint8Array(MAX_BODY + 1) });
  assert.equal(big.status, 413);
  assert.equal(github.dispatched.length, 0);
});

test("anything else is not here, and an unknown job is lost", async () => {
  assert.equal((await call("GET", "/v1/job/not-a-job")).status, 404);
  assert.equal((await call("GET", "/")).status, 404);
  assert.equal((await call("GET", "/v1/github/0123")).status, 404);
  assert.equal((await call("GET", "/v1/job/0123456789abcdef01234567")).status, 404);
});

test("GitHub's hourly limit spent: a job asked here keeps going, an unknown one is retried", async () => {
  const { job } = await (await call("POST", "/v1/build?version=0.8.0", { body: mods })).json();
  const limited = github.fetch.bind(github);
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.host === "api.github.com") return new Response('{"message":"API rate limit exceeded"}', { status: 403 });
    return limited(input, init);
  };
  // Asked five minutes ago: past the "just asked" answer, so its place would be looked up.
  const asked = cache.entries.get(`https://starling-compile.cache/asked/${job}`);
  asked.body = JSON.stringify({ at: Date.now() / 1000 - 300 });
  const told = await (await call("GET", `/v1/job/${job}`)).json();
  assert.equal(told.state, "building", "asked here: still building, not an error");
  const unknown = await call("GET", "/v1/job/eeeeeeeeeeeeeeeeeeeeeeee");
  assert.equal(unknown.status, 503, "can't tell: the game tries again, not 'lost'");
});

test("a job whose run ended without an answer is told so, and asking again builds it again", async () => {
  const { job } = await (await call("POST", "/v1/build?version=0.8.0", { body: mods })).json();
  // Asked 15 minutes ago; its run is gone from the line and published nothing.
  const asked = cache.entries.get(`https://starling-compile.cache/asked/${job}`);
  asked.body = JSON.stringify({ at: Date.now() / 1000 - 900 });
  const told = await (await call("GET", `/v1/job/${job}`)).json();
  assert.deepEqual(told, { state: "failed", error: "The build on GitHub did not finish. Try again.", settled: false });
  await call("POST", "/v1/build?version=0.8.0", { body: mods });
  assert.equal(github.dispatched.length, 2, "built again");
});

test("with the GitHub App, calls carry the installation's token, made once while it lasts", async () => {
  const app = { GITHUB_APP_ID: " 5775282\n", GITHUB_APP_KEY: appKeys.privateKey, HOLD_MS: 0 };
  github.token = "ghs_test";
  const response = await call("POST", "/v1/build?version=0.8.0", { body: mods, as: app });
  assert.equal(response.status, 200);
  assert.equal(github.dispatched.length, 1);
  const { job } = await response.json();
  assert.equal((await call("GET", `/v1/job/${job}`, { as: app })).status, 200);
  const other = new TextEncoder().encode("other mods ".repeat(100));
  assert.equal((await call("POST", "/v1/build?version=0.8.0", { body: other, as: app })).status, 200);
  assert.equal(github.dispatched.length, 2);
  assert.equal(github.minted, 1, "one token for every call while it lasts");
});

test("a fork's service builds in, and serves from, the repository REPO names", async () => {
  const fork = { ...env, REPO: " sayo/mod-builds\n" };
  github.repo = "sayo/mod-builds";
  const response = await call("POST", "/v1/build?version=0.8.0", { body: mods, as: fork });
  assert.equal(response.status, 200, "versions.json read from the fork");
  assert.equal(github.dispatched.length, 1, "the fork's build.yml started");
  assert.equal(github.assets.requests.size, 1, "the mods sealed into the fork's requests release");
  const job = "e123456789abcdef01234567";
  const resumed = await worker.fetch(
    new Request(`https://starling-compile.example/v1/job/${job}/lib`, { headers: { Range: "bytes=2-" } }),
    fork,
    ctx,
  );
  assert.equal(resumed.headers.get("Location"), `https://github.com/sayo/mod-builds/releases/download/results/${job}.so`);
});

test("REPO is an owner/name, or the service's own repository", () => {
  assert.equal(repoOf({}), REPO);
  assert.equal(repoOf({ REPO: "" }), REPO);
  assert.equal(repoOf({ REPO: "just-a-name" }), REPO);
  assert.equal(repoOf({ REPO: "a/b/c" }), REPO);
  assert.equal(repoOf({ REPO: "https://github.com/a/b" }), REPO);
  assert.equal(repoOf({ REPO: "Sayo-Nara/mod-builds.fork" }), "Sayo-Nara/mod-builds.fork");
});

test("GitHub out of reach is a 503 with words", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("network down");
  };
  const response = await call("POST", "/v1/build?version=0.8.0", { body: mods });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /can't reach GitHub/);
});

// Compile v2: one library per mod, kept in the store.

const BUILD = "5e1f0c2d3a4b5c6d7e8f90a1b2c3d4e5f6a7b8c9";
const hmod = new TextEncoder().encode("PK the mod's .hmod ".repeat(50));

/** The store with game build BUILD in it, for ARM64. */
function store() {
  const builds = { schema: 1, builds: [{ build: BUILD, nightly: "nightly-2026-11-20", abis: { "arm64-v8a": {} } }] };
  github.assets.store = new Map([["builds.json", new TextEncoder().encode(JSON.stringify(builds))]]);
  github.assets[modsTag(BUILD)] = new Map();
}

test("a v2 job is the .hmod's own hash and the ABI, the same as the store's", async () => {
  const want = createHash("sha256").update(hmod).digest("hex").slice(0, 32);
  assert.equal(await modJobOf(hmod, "arm64-v8a"), `${want}.arm64-v8a`);
  assert.equal(await askOf(BUILD, `${want}.arm64-v8a`), await askOf(BUILD, `${want}.arm64-v8a`));
  assert.notEqual(await askOf(BUILD, `${want}.arm64-v8a`), await askOf(BUILD, `${want}.x86_64`));
});

test("a mod the store doesn't have is sealed and built once, however often it is asked", async () => {
  store();
  const first = await call("POST", `/v2/mod?build=${BUILD}&abi=arm64-v8a`, { body: hmod });
  assert.equal(first.status, 200);
  const told = await first.json();
  assert.deepEqual(told, { job: await modJobOf(hmod, "arm64-v8a"), repo: REPO, tag: `mods-${BUILD}` });
  assert.equal(github.modDispatched.length, 1);
  const { ref, inputs } = github.modDispatched[0];
  assert.equal(ref, "main");
  assert.deepEqual(Object.keys(inputs).sort(), ["abi", "ask", "build", "job", "key"]);
  assert.equal(inputs.ask, await askOf(BUILD, told.job));
  const sealed = github.assets.requests.get(`${inputs.ask}.bin`);
  const opened = createDecipheriv("aes-256-ctr", Buffer.from(inputs.key.slice(0, 64), "hex"), Buffer.from(inputs.key.slice(64), "hex"));
  assert.deepEqual(new Uint8Array(Buffer.concat([opened.update(sealed), opened.final()])), hmod);
  // Asked again, from anywhere: its request is there, so it is on its way. No cache needed.
  cache.entries.clear();
  const again = await call("POST", `/v2/mod?build=${BUILD}&abi=arm64-v8a`, { body: hmod, address: "198.51.100.9" });
  assert.deepEqual(await again.json(), told);
  assert.equal(github.modDispatched.length, 1, "nothing new started");
  assert.equal(github.dispatched.length, 0, "never the whole-game build");
});

test("a mod the store has, or that fails for good, starts nothing and calls no API", async () => {
  store();
  const job = await modJobOf(hmod, "arm64-v8a");
  github.assets[modsTag(BUILD)].set(`${job}.json`, new TextEncoder().encode("{}"));
  const before = github.calls;
  assert.equal((await call("POST", `/v2/mod?build=${BUILD}&abi=arm64-v8a`, { body: hmod })).status, 200);
  github.assets[modsTag(BUILD)].clear();
  const failed = { state: "failed", error: "error[E0425]", settled: true, at: 1 };
  github.assets[modsTag(BUILD)].set(`${job}.failed.json`, new TextEncoder().encode(JSON.stringify(failed)));
  assert.equal((await call("POST", `/v2/mod?build=${BUILD}&abi=arm64-v8a`, { body: hmod })).status, 200);
  assert.equal(github.calls, before, "no call to GitHub's API");
  assert.equal(github.modDispatched.length, 0);
  assert.deepEqual(await (await call("GET", `/v2/mod/${BUILD}/${job}`)).json(), { state: "failed", error: "error[E0425]", settled: true });
});

test("a failure that may pass is built again", async () => {
  store();
  const job = await modJobOf(hmod, "arm64-v8a");
  const failed = { state: "failed", error: "GitHub's machine went away.", settled: false, at: 1 };
  github.assets[modsTag(BUILD)].set(`${job}.failed.json`, new TextEncoder().encode(JSON.stringify(failed)));
  await call("POST", `/v2/mod?build=${BUILD}&abi=arm64-v8a`, { body: hmod });
  assert.equal(github.modDispatched.length, 1);
});

test("a build or ABI the store doesn't serve is said in words the game shows", async () => {
  store();
  for (const query of [`build=${BUILD}&abi=x86_64`, `build=${"0".repeat(40)}&abi=arm64-v8a`, `build=main&abi=arm64-v8a`, `build=${BUILD}&abi=mips`]) {
    const response = await call("POST", `/v2/mod?${query}`, { body: hmod });
    assert.equal(response.status, 400, query);
    assert.match((await response.json()).error, /Update Starling/);
  }
  assert.equal((await call("POST", `/v2/mod?build=${BUILD}&abi=arm64-v8a`, { body: new Uint8Array() })).status, 413);
  assert.equal(github.modDispatched.length, 0);
});

test("a v2 job long in coming: its place in line, its answer, or lost and asked again", async () => {
  store();
  const { job } = await (await call("POST", `/v2/mod?build=${BUILD}&abi=arm64-v8a`, { body: hmod })).json();
  // Just asked, not listed yet: in line.
  assert.equal((await (await call("GET", `/v2/mod/${BUILD}/${job}`)).json()).state, "queued");
  github.modRuns = [{ display_title: `mod ${job} ${BUILD}`, status: "in_progress", run_started_at: new Date().toISOString() }];
  cache.entries.clear();
  assert.equal((await (await call("GET", `/v2/mod/${BUILD}/${job}`)).json()).state, "building");
  // Its run gone without an answer, its request asked long ago: lost, and the request goes.
  github.modRuns = [];
  cache.entries.clear();
  const ask = await askOf(BUILD, job);
  github.created.set(`requests/${ask}.bin`, new Date(Date.now() - 900e3).toISOString());
  assert.deepEqual(await (await call("GET", `/v2/mod/${BUILD}/${job}`)).json(), {
    state: "failed",
    error: "The build on GitHub did not finish. Try again.",
    settled: false,
  });
  assert.deepEqual(github.deleted, [`requests/${ask}.bin`]);
  await call("POST", `/v2/mod?build=${BUILD}&abi=arm64-v8a`, { body: hmod });
  assert.equal(github.modDispatched.length, 2, "asked again: built again");
  // Done: the answer the store has.
  const done = { state: "done", sha256: "c".repeat(64), size: 9 };
  github.assets[modsTag(BUILD)].set(`${job}.json`, new TextEncoder().encode(JSON.stringify(done)));
  assert.deepEqual(await (await call("GET", `/v2/mod/${BUILD}/${job}`)).json(), done);
  assert.equal((await call("GET", `/v2/mod/${BUILD}/${"f".repeat(32)}.arm64-v8a`)).status, 404);
  assert.equal((await call("GET", `/v2/mod/${BUILD}/${job.replace("arm64-v8a", "mips")}`)).status, 404);
});

test("the v1 answer names the repository the game waits in, a fork's too", async () => {
  const fork = { ...env, REPO: "sayo/mod-builds" };
  github.repo = "sayo/mod-builds";
  const told = await (await call("POST", "/v1/build?version=0.8.0", { body: mods, as: fork })).json();
  assert.deepEqual(told, { job: await jobOf("0.8.0", COMMIT, mods), repo: "sayo/mod-builds" });
});

test("original Preview 4 custom server uses exact v1 build version", async () => {
  const version = "0.9.0-preview.cac7bf6459";
  const response = await call("POST", "/v1/build?version=" + version, {
    body: new TextEncoder().encode("preview native request"),
  });
  assert.equal(response.status, 200);
  assert.equal(github.dispatched.at(-1).inputs.version, version);
  const wrong = await call("POST", "/v1/build?version=0.9.0-preview.0000000000", {
    body: new TextEncoder().encode("preview native request"),
  });
  assert.equal(wrong.status, 400);
});
