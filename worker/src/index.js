// Starling's Compile service on Cloudflare Workers: the door the game knows
// (packaging/android/build-server.txt in starling-client/starling), with this repository's
// GitHub Actions as the machines and its releases as the store. It replaces the gateway that
// lived on a paid VM (mod_build_gateway.py) and keeps the game's side as it was:
//
//   POST /v1/build?version=V   the mods (the game's bundle) in the body: {"job", "repo"}, or {"error"}
//   GET  /v1/job/J             {"state": "queued" | "building" | "done" | "failed", ...}
//   GET  /v1/job/J/lib         the library, from the `results` release (a redirect)
//
// A Starling that knows `repo` waits for the answer in that repository's releases itself
// (results-<J's first digit>/J.json or J.failed.json, then J.so), and asks /v1/job only now and
// then: the free plan counts every request, and the hold below is for the Starlings before it.
//
// Compile v2, one library per mod, built against a game build's SDK (a Nightly) and kept in the
// store (scripts/store.py): the game reads store/builds.json and mods-<build>/index.json straight
// from GitHub, and comes here only for a mod the index doesn't have:
//
//   POST /v2/mod?build=B&abi=A the mod's .hmod in the body: {"job", "repo", "tag"}, or {"error"}
//   GET  /v2/mod/B/J           where job J stands, when its answer is long in coming
//
// J is the .hmod's SHA-256 (32 digits) and the ABI, `<sha>.<abi>`; its answer is J.json or
// J.failed.json in the release `tag` (mods-B), and its library J.so.
//
// The mods are sealed (AES-256-CTR, a key of their own) before they leave here, kept as an asset
// of the `requests` release, and the key goes to the build in its inputs, which only the run
// reads (build.yml, mod.yml, scripts/unseal.sh). The same mods on the same commit are the same
// job: what was built once is served again without a build.
//
// Secrets: GITHUB_APP_ID and GITHUB_APP_KEY (a GitHub App installed on this repository), or
// GITHUB_TOKEN, a fine-grained token for this repository only, with Actions and Contents read and
// write (`token`). A fork of this repository runs its own service with REPO, its "owner/name", in
// wrangler.toml's [vars] (README.md, "Your own build service"). Nothing about a player is kept: an
// address only counts its builds for a day, hashed, in this location's cache.

const MAIN_REPO = "starling-client/mod-builds";
// The repository the service builds in and stores to: env.REPO, the same for every request of a
// deployment, read at the start of each one.
let REPO = MAIN_REPO;
const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";
const downloads = () => `https://github.com/${REPO}/releases/download`;
const WORKFLOW = "build.yml";
const MOD_WORKFLOW = "mod.yml";
const REQUESTS = "requests";
const RESULTS = "results";
// The store's own release: builds.json, every game build the store serves (scripts/store.py).
const STORE = "store";

// What the game sends at most (its LARGEST_REQUEST).
export const MAX_BODY = 32 << 20;
// Builds a day from one address, and from everyone through one Cloudflare location.
export const PER_ADDRESS = 32;
export const PER_DAY = 1500;
const DAY = 24 * 3600;
// How long a build may take before the game is told it is lost (its own wait is 90 minutes).
const LONGEST = 80 * 60;
// How long the answer about a job on its way is held (`status`), and how often the hold looks for
// its answer. The game asks again 2 s after each answer and gives a read 40 s: at 6 s, the first
// evening spent the free plan's 100,000 requests a day (Cloudflare's 429, error 1027) in 5 hours.
const HOLD_MS = 25000;
const LOOK_MS = 5000;
// How long this location keeps its look at the build line (`queue`), and how often a job it can't
// place may make it look again. GitHub gives the token's owner 5,000 calls an hour for everything
// he and his tools do; the first day spent them all at 45 s and 10 s.
const QUEUE_SECONDS = 120;
const LOOK_AGAIN_SECONDS = 60;
// A job asked this long ago, neither in line nor building and with no answer, is taken as lost:
// its run ended without publishing (as when the results release was full).
const LOST_SECONDS = 600;
const DID_NOT_FINISH = "The build on GitHub did not finish. Try again.";

const JOB = /^[0-9a-f]{24}$/;
const VERSION = /^(?:\d+(\.\d+){1,3}|0\.9\.0-preview\.cac7bf6459)$/;
// A game build is its commit; a mod's job is its .hmod's hash and the ABI it is built for.
const BUILD = /^[0-9a-f]{40}$/;
export const ABIS = ["arm64-v8a", "armeabi-v7a", "x86_64", "x86"];
const MOD_JOB = new RegExp(`^[0-9a-f]{32}\\.(${ABIS.join("|")})$`);
const NO_SUCH_BUILD = "This build of the game can't compile mods here. Update Starling.";

const NOT_HERE = "No such thing here.";
const YOUR_LIMIT = "You have compiled a lot today. Try again tomorrow.";
const EVERYONES_LIMIT = "The build service has done all it can today. Try again tomorrow.";
const UNAVAILABLE = "The build service can't reach GitHub right now. Try again later.";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    REPO = repoOf(env);
    try {
      if (request.method === "POST" && url.pathname === "/v1/build") {
        return await build(request, url, env, ctx);
      }
      if (request.method === "GET" && parts[0] === "v1" && parts[1] === "job" && JOB.test(parts[2] ?? "")) {
        if (parts.length === 3) return await status(parts[2], env, ctx);
        if (parts.length === 4 && parts[3] === "lib") return await library(parts[2], request);
      }
      if (request.method === "POST" && url.pathname === "/v2/mod") return await modBuild(request, url, env, ctx);
      if (
        request.method === "GET" &&
        parts.length === 4 &&
        parts[0] === "v2" &&
        parts[1] === "mod" &&
        BUILD.test(parts[2]) &&
        MOD_JOB.test(parts[3])
      ) {
        return await modStatus(parts[2], parts[3], env, ctx);
      }
      return answer(404, { error: NOT_HERE });
    } catch (e) {
      console.log(`${request.method} ${url.pathname}: ${e?.stack ?? e}`);
      return answer(503, { error: UNAVAILABLE });
    }
  },
};

/** env.REPO when it is an "owner/name", else this service's own repository. */
export function repoOf(env) {
  const repo = String(env.REPO ?? "").trim();
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : MAIN_REPO;
}

/** A new build of `version` with the body's mods, or the job that already has them. */
async function build(request, url, env, ctx) {
  const version = url.searchParams.get("version") ?? "";
  if (!VERSION.test(version)) return answer(400, { error: "That is not a version of the game." });
  const body = await bodyOf(request);
  if (!body) return answer(413, { error: "That is too big to compile." });
  const commit = (await versions())[version];
  if (!commit) {
    return answer(400, {
      error: "This version of Starling can't compile mods any more. Update Starling.",
    });
  }
  const job = await jobOf(version, commit, body);
  // Where the game waits for the answer by itself, with no request here (results-<job[0]>).
  const told = { job, repo: REPO };
  // Built before, failing for good, or on its way: the job is all the game needs. A failure that
  // may pass another time (a machine that went away) is built again.
  if (await published(`${job}.json`, ctx)) return answer(200, told);
  const failure = await failureOf(job, ctx);
  if (failure?.settled) return answer(200, told);
  const asked = await recall(`asked/${job}`);
  if (asked && !(failure && (failure.at ?? 0) >= asked.at)) {
    // Still on its way, or not long enough asked to tell: the same job. One asked long ago and
    // gone from the line without an answer is built again.
    const gone = now() - asked.at > LOST_SECONDS && !(await running(job, env, ctx));
    if (!gone) return answer(200, told);
  }
  const run = failure ? null : await running(job, env, ctx, false);
  if (run && !run.unknown) return answer(200, told);

  const limited = await limit(request, ctx);
  if (limited) return limited;

  const { sealed, key } = await seal(body);
  const ask = hex(crypto.getRandomValues(new Uint8Array(16)));
  await upload(env, ctx, REQUESTS, `${ask}.bin`, sealed);
  await github(env, "POST", `/actions/workflows/${WORKFLOW}/dispatches`, {
    ref: "main",
    inputs: { job, ask, key, version },
  });
  ctx.waitUntil(remember(`asked/${job}`, { at: now() }, LONGEST));
  return answer(200, told);
}

/** The request's body, or null when it is empty or bigger than the service takes. */
async function bodyOf(request) {
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (declared > MAX_BODY) return null;
  const body = new Uint8Array(await request.arrayBuffer());
  return body.length === 0 || body.length > MAX_BODY ? null : body;
}

/** The 429 the game shows when this address, or everyone, has built enough today; else null. */
async function limit(request, ctx) {
  const address = await hashed(request.headers.get("CF-Connecting-IP") ?? "unknown");
  if (!(await count(`address/${address}`, PER_ADDRESS, ctx))) return answer(429, { error: YOUR_LIMIT });
  if (!(await count("everyone", PER_DAY, ctx))) return answer(429, { error: EVERYONES_LIMIT });
  return null;
}

/**
 * Compile v2: one mod's library for game build `build` and `abi`, or the job that has it. Nothing
 * here leans on this location's cache (on *.workers.dev Cloudflare keeps none): a job is done when
 * its J.json is in mods-<build>, and on its way while its sealed request is in `requests`, under a
 * name made from the job, so a second ask finds it there and starts nothing (mod.yml lets it go
 * when it publishes, scripts/clean.py after six hours).
 */
async function modBuild(request, url, env, ctx) {
  const build = url.searchParams.get("build") ?? "";
  const abi = url.searchParams.get("abi") ?? "";
  if (!BUILD.test(build) || !ABIS.includes(abi)) return answer(400, { error: NO_SUCH_BUILD });
  const body = await bodyOf(request);
  if (!body) return answer(413, { error: "That is too big to compile." });
  const known = (await builds()).find((b) => b.build === build);
  if (!known?.abis?.[abi]) return answer(400, { error: NO_SUCH_BUILD });
  const job = await modJobOf(body, abi);
  const tag = modsTag(build);
  const told = { job, repo: REPO, tag };
  if (await there(tag, `${job}.json`)) return answer(200, told);
  const failure = await jsonIn(tag, `${job}.failed.json`);
  if (failure?.settled) return answer(200, told);
  const ask = await askOf(build, job);
  if (await there(REQUESTS, `${ask}.bin`)) return answer(200, told);

  const limited = await limit(request, ctx);
  if (limited) return limited;

  const { sealed, key } = await seal(body);
  // Two games asking at once: the second upload finds the first's, and builds nothing.
  if (!(await upload(env, ctx, REQUESTS, `${ask}.bin`, sealed))) return answer(200, told);
  await github(env, "POST", `/actions/workflows/${MOD_WORKFLOW}/dispatches`, {
    ref: "main",
    inputs: { build, abi, job, ask, key },
  });
  return answer(200, told);
}

/**
 * Where a v2 job stands, for a game whose answer is long in coming (it waits on GitHub itself and
 * asks here every ten minutes or so): its answer, its place in the line, or that its run ended
 * without one, which lets the request go so that asking again builds it again.
 */
async function modStatus(build, job, env, ctx) {
  const tag = modsTag(build);
  const done = await jsonIn(tag, `${job}.json`);
  if (done) return answer(200, done);
  const ask = await askOf(build, job);
  if (await there(REQUESTS, `${ask}.bin`)) {
    const run = await running(job, env, ctx, true, MOD_WORKFLOW, modTitle(build, job));
    if (run?.unknown) throw new Error(`the line of ${job} can't be read`);
    if (run) return answer(200, run);
    const asset = (await assets(env, ctx, REQUESTS)).find((a) => a.name === `${ask}.bin`);
    const since = asset ? Date.parse(asset.created_at) / 1000 : now();
    if (now() - since <= LOST_SECONDS) {
      // Asked a moment ago: GitHub lists a run a little after it is asked for.
      return answer(200, { state: "queued", ahead: (await queue(env, ctx, false, MOD_WORKFLOW)).queued.length });
    }
    if (asset) await github(env, "DELETE", `/releases/assets/${asset.id}`);
    return answer(200, { state: "failed", error: DID_NOT_FINISH, settled: false });
  }
  const failure = await jsonIn(tag, `${job}.failed.json`);
  if (failure) {
    const { state, error, settled } = failure;
    return answer(200, { state, error, settled: Boolean(settled) });
  }
  return answer(404, { error: "No such job." });
}

/** The release of game build `build` in the store: its index.json and its mods' libraries. */
export function modsTag(build) {
  return `mods-${build}`;
}

/** A v2 job: the .hmod's SHA-256 (128 bits of it) and the ABI it is built for. */
export async function modJobOf(body, abi) {
  return `${hex(new Uint8Array(await crypto.subtle.digest("SHA-256", body))).slice(0, 32)}.${abi}`;
}

/** The sealed request's name in `requests`, the same for the same job on the same build. */
export async function askOf(build, job) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`mod ${build} ${job}`));
  return hex(new Uint8Array(digest)).slice(0, 32);
}

/** mod.yml's run-name for a job, which the line is read by. */
function modTitle(build, job) {
  return `mod ${job} ${build}`;
}

/** store/builds.json's builds, newest first; none while the store has none. */
async function builds() {
  const listed = await jsonIn(STORE, "builds.json", { cf: { cacheTtl: 300, cacheEverything: true } });
  return Array.isArray(listed?.builds) ? listed.builds : [];
}

/** Whether release `tag` has an asset `name`, from its download (no API call): GitHub sends it on. */
async function there(tag, name) {
  const response = await fetch(`${downloads()}/${tag}/${name}`, { method: "HEAD", redirect: "manual" });
  if (response.status === 404) return false;
  if (response.status < 400) return true;
  throw new Error(`${tag}/${name}: ${response.status}`);
}

/** The JSON asset `name` of release `tag`, or null when it is not there. */
async function jsonIn(tag, name, init = {}) {
  const response = await fetch(`${downloads()}/${tag}/${name}`, { redirect: "follow", ...init });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${tag}/${name}: ${response.status}`);
  return response.json();
}

/**
 * What the game shows while it waits, and the library's checksum once it is there. A job still on
 * its way is answered after HOLD_MS, or as soon as a look finds its answer: the game asks again
 * 2 s after each answer, so holding it makes every Starling, old ones too, ask over ten times less
 * while it waits (the free plan counts requests). Its read waits 40 s, beyond the hold.
 */
async function status(job, env, ctx) {
  const done = await published(`${job}.json`, ctx);
  if (done) return answer(200, done);
  const told = await waiting(job, env, ctx);
  const hold = Number(env.HOLD_MS ?? HOLD_MS);
  if (hold > 0 && (told?.state === "building" || told?.state === "queued")) {
    const step = Math.min(hold, Number(env.LOOK_MS ?? LOOK_MS));
    for (let held = 0; held < hold; held += step) {
      await new Promise((resolve) => setTimeout(resolve, step));
      const doneSince = await published(`${job}.json`, ctx);
      if (doneSince) return answer(200, doneSince);
      if (await failureOf(job, ctx)) {
        const since = await waiting(job, env, ctx);
        if (since?.state === "failed") return answer(200, since);
      }
    }
  }
  return told ? answer(200, told) : answer(404, { error: "No such job." });
}

/** A job not done: its failure or how it goes, or null when there is none. */
async function waiting(job, env, ctx) {
  const failure = await failureOf(job, ctx);
  const asked = await recall(`asked/${job}`);
  // A failure the build ran again since is old news.
  if (failure && !(asked && asked.at > (failure.at ?? 0))) {
    const { state, error, settled } = failure;
    return { state, error, settled: Boolean(settled) };
  }
  // Just asked here: at the end of the line, with no call (GitHub lists a run a little after it
  // is asked for, and the line read may be up to QUEUE_SECONDS old).
  if (asked && now() - asked.at < 120) {
    const line = await recall("queue");
    return { state: "queued", ahead: line?.value.queued.length ?? 0 };
  }
  const lost = asked && now() - asked.at > LOST_SECONDS;
  const run = await running(job, env, ctx, !asked || lost);
  if (run && !run.unknown) return run;
  // Asked long ago and neither in line nor building, with no answer: its run ended without
  // publishing one. The game is told so, and asking again builds it again.
  if (lost && !run) return { state: "failed", error: DID_NOT_FINISH, settled: false };
  if (!asked) {
    // GitHub can't be asked right now: the game tries again, not "lost".
    if (run?.unknown) throw new Error(`the line of ${job} can't be read`);
    return null;
  }
  // Whole seconds: the game reads them as an integer (`as_u64`), and a fraction reads as none.
  return { state: "building", seconds: Math.max(0, Math.floor(now() - asked.at)) };
}

/**
 * The finished library. A download that goes on from where it stopped (`Range: bytes=N-`, N > 0)
 * is sent to GitHub, which answers 206 with the rest. One from the start comes through here as a
 * 200: the game asks for it with `bytes=0-` and takes a 206 as more of a file it already has
 * (0.8.0's `fetch_library` opens it to append), and GitHub answers `bytes=0-` with 206, so a
 * redirect there failed every first download with "No such file or directory (os error 2)".
 */
async function library(job, request) {
  const name = `${job}.so`;
  const from = /^bytes=(\d+)-$/.exec(request.headers.get("Range") ?? "");
  if (from && Number(from[1]) > 0) {
    const shard = await fetch(`${downloads()}/${shardOf(name)}/${name}`, { method: "HEAD", redirect: "follow" });
    const tag = shard.status === 404 ? RESULTS : shardOf(name);
    return new Response(null, { status: 302, headers: { Location: `${downloads()}/${tag}/${name}` } });
  }
  const upstream = await fetchResult(name);
  if (upstream.status === 404) return answer(404, { error: "No such build. Compile again." });
  if (!upstream.ok) throw new Error(`${job}.so: ${upstream.status}`);
  const headers = { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" };
  const length = upstream.headers.get("Content-Length");
  if (length) headers["Content-Length"] = length;
  return new Response(upstream.body, { status: 200, headers });
}

/**
 * The release a build's files go to: a release holds 1000 assets at most, and the first evening
 * filled `results`, so builds are spread over results-0 to results-f by the job's first hex digit
 * (scripts/publish.py).
 */
function shardOf(name) {
  return `results-${name[0]}`;
}

/** One of a build's files: in its shard, or in `results`, where the first evening's builds are. */
async function fetchResult(name) {
  for (const tag of [shardOf(name), RESULTS]) {
    const response = await fetch(`${downloads()}/${tag}/${name}`, { redirect: "follow" });
    if (response.status !== 404) return response;
  }
  return new Response("Not Found", { status: 404 });
}

/** The job of these mods on this commit: the same mods ask for the same build. */
export async function jobOf(version, commit, body) {
  const asked = new TextEncoder().encode(`/v1/build?version=${version}&commit=${commit}`);
  const all = new Uint8Array(asked.length + body.length);
  all.set(asked);
  all.set(body, asked.length);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", all))).slice(0, 24);
}

/**
 * The body sealed with AES-256-CTR under a fresh key: `key` is the key's hex and then the counter
 * block's, as `openssl enc -aes-256-ctr -K -iv` takes them. The counter's low 64 bits start at
 * zero, so WebCrypto's 64-bit counter and OpenSSL's 128-bit one never part.
 */
export async function seal(body) {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const counter = crypto.getRandomValues(new Uint8Array(16));
  counter.fill(0, 8);
  const key = await crypto.subtle.importKey("raw", raw, "AES-CTR", false, ["encrypt"]);
  const sealed = await crypto.subtle.encrypt({ name: "AES-CTR", counter, length: 64 }, key, body);
  return { sealed: new Uint8Array(sealed), key: hex(raw) + hex(counter) };
}

/** versions.json: each version the service compiles, and its commit. */
async function versions() {
  const response = await fetch(`https://raw.githubusercontent.com/${REPO}/main/versions.json`, {
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!response.ok) throw new Error(`versions.json: ${response.status}`);
  return response.json();
}

/**
 * One of the results release's JSON files, or null; kept here an hour once there (scripts/clean.py
 * deletes old builds), 15 s while not.
 */
async function published(name, ctx, seconds = 3600) {
  const key = `published/${name}`;
  const known = await recall(key);
  if (known) return known.value;
  const response = await fetchResult(name);
  if (response.status === 404) {
    ctx.waitUntil(remember(key, { value: null }, 15));
    return null;
  }
  if (!response.ok) throw new Error(`${name}: ${response.status}`);
  const value = await response.json();
  ctx.waitUntil(remember(key, { value }, seconds));
  return value;
}

/** The last failure published for `job`, which a new run replaces. */
function failureOf(job, ctx) {
  return published(`${job}.failed.json`, ctx, 30);
}

/** The job's run on GitHub when it is queued or going: what the game is told of it. */
async function running(job, env, ctx, mayLookAgain = true, workflow = WORKFLOW, title = `build ${job}`) {
  try {
    let found = placeIn(await queue(env, ctx, false, workflow), title);
    // Not in the line as last seen: it moved since (from waiting to building, between two
    // looks), or that look came back short. Look again before calling it lost, at most every
    // LOOK_AGAIN_SECONDS here: a job told "No such job" is given up by the game.
    if (!found && mayLookAgain && !(await recall(`queue-fresh/${workflow}`))) {
      await remember(`queue-fresh/${workflow}`, { at: now() }, LOOK_AGAIN_SECONDS);
      found = placeIn(await queue(env, ctx, true, workflow), title);
    }
    return found;
  } catch (e) {
    // GitHub refused (its hourly limit) or is down: where the job stands is unknown.
    console.log(`the line: ${e}`);
    return { unknown: true };
  }
}

/** Where `title` stands in the line `queue` read, or null when it is not in it. */
function placeIn({ queued, building }, title) {
  if (title in building) {
    return { state: "building", seconds: Math.max(0, Math.floor(now() - building[title])) };
  }
  const place = queued.indexOf(title);
  return place >= 0 ? { state: "queued", ahead: place } : null;
}

/**
 * The build workflow's line on GitHub: the jobs waiting, oldest first, and when each running one
 * began. Read once for everyone every QUEUE_SECONDS in this location, so a game in line learns
 * its place ("In line: N before yours") without a call of its own: GitHub gives a token 5,000 a
 * hour, and a busy hour has a hundred jobs in line asking every few seconds.
 */
async function queue(env, ctx, fresh = false, workflow = WORKFLOW) {
  // build.yml's line keeps its old name, which every location's cache already holds.
  const name = workflow === WORKFLOW ? "queue" : `queue/${workflow}`;
  const known = fresh ? null : await recall(name);
  if (known) return known.value;
  const list = async (status) => {
    const runs = [];
    for (let page = 1; page <= 5; page++) {
      const { workflow_runs: some } = await github(
        env,
        "GET",
        `/actions/workflows/${workflow}/runs?event=workflow_dispatch&status=${status}&per_page=100&page=${page}`,
      );
      runs.push(...some);
      if (some.length < 100) break;
    }
    return runs;
  };
  const queued = (await list("queued"))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .map((r) => r.display_title);
  const building = Object.fromEntries(
    (await list("in_progress")).map((r) => [
      r.display_title,
      Date.parse(r.run_started_at ?? r.created_at ?? "") / 1000 || now(),
    ]),
  );
  const value = { queued, building };
  ctx.waitUntil(remember(name, { value }, QUEUE_SECONDS));
  return value;
}

/**
 * Puts `bytes` in release `tag` as `name`: true, or false when an asset of that name is there
 * already (GitHub's 422 `already_exists`).
 */
async function upload(env, ctx, tag, name, bytes) {
  const id = await releaseId(env, ctx, tag);
  const response = await fetch(
    `${UPLOADS}/repos/${REPO}/releases/${id}/assets?name=${encodeURIComponent(name)}`,
    { method: "POST", headers: { ...(await headers(env)), "Content-Type": "application/octet-stream" }, body: bytes },
  );
  if (response.ok) return true;
  const text = await response.text();
  if (response.status === 422 && text.includes("already_exists")) return false;
  throw new Error(`upload ${tag}/${name}: ${response.status} ${text}`);
}

/** Release `tag`'s assets, up to 300 of them (`requests` holds a few hours of asks at most). */
async function assets(env, ctx, tag) {
  const id = await releaseId(env, ctx, tag);
  const all = [];
  for (let page = 1; page <= 3; page++) {
    const some = await github(env, "GET", `/releases/${id}/assets?per_page=100&page=${page}`);
    all.push(...some);
    if (some.length < 100) break;
  }
  return all;
}

async function releaseId(env, ctx, tag) {
  const key = `release/${tag}`;
  const known = await recall(key);
  if (known) return known.value;
  const { id } = await github(env, "GET", `/releases/tags/${tag}`);
  ctx.waitUntil(remember(key, { value: id }, DAY));
  return id;
}

/** One call to the repository's API: its JSON, or null when it answers nothing. */
async function github(env, method, path, payload) {
  const response = await fetch(`${API}/repos/${REPO}${path}`, {
    method,
    headers: { ...(await headers(env)), ...(payload ? { "Content-Type": "application/json" } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function headers(env) {
  return { ...plainHeaders(), Authorization: `Bearer ${await token(env)}` };
}

function plainHeaders() {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "starling-compile",
  };
}

// The GitHub App's installation token, while it lasts, in this isolate.
let installation = null;

/**
 * The token the service acts with. With the GitHub App (secrets GITHUB_APP_ID and GITHUB_APP_KEY,
 * the App's private key as PKCS#8 PEM; the App is installed on mod-builds alone), an installation
 * token: it has its own hourly limit, and the builds are the App's, not a person's (no failure
 * mails to the owner). Without it, GITHUB_TOKEN, a person's token, which shares that person's
 * 5,000 calls an hour with everything else they do.
 */
async function token(env) {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_KEY) return env.GITHUB_TOKEN;
  if (installation && installation.until > now() + 120) return installation.token;
  const app = { ...plainHeaders(), Authorization: `Bearer ${await appJwt(env)}` };
  const listed = await fetch(`${API}/app/installations`, { headers: app });
  if (!listed.ok) throw new Error(`the App's installations: ${listed.status}`);
  const owner = REPO.split("/")[0];
  const id = (await listed.json()).find((i) => i.account?.login === owner)?.id;
  if (!id) throw new Error(`the App is not installed on ${owner}`);
  const made = await fetch(`${API}/app/installations/${id}/access_tokens`, { method: "POST", headers: app });
  if (!made.ok) throw new Error(`the App's token: ${made.status}`);
  const { token: value, expires_at: expires } = await made.json();
  installation = { token: value, until: Date.parse(expires) / 1000 };
  return value;
}

/** The App's own JWT (RS256, ten minutes at most), to ask for an installation token. */
async function appJwt(env) {
  const base64url = (bytes) =>
    btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const part = (value) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  const at = Math.floor(now());
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: at - 60, exp: at + 540, iss: String(env.GITHUB_APP_ID).trim() })}`;
  const der = Uint8Array.from(atob(env.GITHUB_APP_KEY.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) =>
    c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}

/** Adds one to today's count of `name` unless it is at `limit`: whether it was below. */
async function count(name, limit, ctx) {
  const key = `count/${Math.floor(now() / DAY)}/${name}`;
  const known = await recall(key);
  const n = known?.value ?? 0;
  if (n >= limit) return false;
  ctx.waitUntil(remember(key, { value: n + 1 }, DAY));
  return true;
}

// This location's cache holds what is worth not asking GitHub again; keys are made-up URLs.
function cacheKey(name) {
  return new Request(`https://starling-compile.cache/${name}`);
}

async function recall(name) {
  const hit = await caches.default.match(cacheKey(name));
  return hit ? hit.json() : null;
}

function remember(name, value, seconds) {
  return caches.default.put(
    cacheKey(name),
    new Response(JSON.stringify(value), {
      headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${seconds}` },
    }),
  );
}

async function hashed(text) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))).slice(0, 32);
}

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function now() {
  return Date.now() / 1000;
}

function answer(code, body) {
  return new Response(JSON.stringify(body), {
    status: code,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
