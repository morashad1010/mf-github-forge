import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { parse as parseUrl } from "node:url";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";

const JSON_TYPE = "application/json; charset=utf-8";
const GIT_UPLOAD_PACK = "application/x-git-upload-pack-advertisement";
const GIT_UPLOAD_PACK_RESULT = "application/x-git-upload-pack-result";
const GIT_RECEIVE_PACK = "application/x-git-receive-pack-advertisement";
const GIT_RECEIVE_PACK_RESULT = "application/x-git-receive-pack-result";

interface Repo {
  owner: string;
  name: string;
  description: string | null;
  private: boolean;
  default_branch: string;
  objects: Map<string, Buffer>;  // sha -> content
  refs: Map<string, string>;     // ref -> sha
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  labels: Map<string, Label>;
  next_issue: number;
  next_pull: number;
}

interface Issue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: string[];
  user: { login: string };
  created_at: string;
  updated_at: string;
}

interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed" | "merged";
  head: { ref: string; sha: string; repo: { full_name: string } };
  base: { ref: string; sha: string; repo: { full_name: string } };
  user: { login: string };
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
}

interface Label {
  name: string;
  color: string;
  description: string | null;
}

const repos = new Map<string, Repo>();
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN || "test-token";

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body) + "\n";
  res.writeHead(status, { "content-type": JSON_TYPE, "content-length": Buffer.byteLength(text), "x-github-request-id": createHash("sha256").update(Math.random().toString()).digest("hex").slice(0, 20), ...headers });
  res.end(text);
}

function sendText(res: ServerResponse, status: number, body: string, ctype: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": ctype, "content-length": Buffer.byteLength(body), ...headers });
  res.end(body);
}

function auth(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  return token === TOKEN ? "testuser" : null;
}

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

function createRepo(owner: string, name: string, description: string | null, private_: boolean): Repo {
  const repo: Repo = {
    owner, name, description, private: private_, default_branch: "main",
    objects: new Map(), refs: new Map([["refs/heads/main", "0".repeat(40)]]),
    issues: new Map(), pulls: new Map(), labels: new Map(),
    next_issue: 1, next_pull: 1
  };
  repos.set(repoKey(owner, name), repo);
  return repo;
}

function sha1(data: Buffer): string {
  return createHash("sha1").update(data).digest("hex");
}

function writePktLine(data: string | Buffer): Buffer {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const len = buf.length + 4;
  const hex = len.toString(16).padStart(4, "0");
  return Buffer.concat([Buffer.from(hex), buf]);
}

function readPktLines(buf: Buffer): string[] {
  const lines: string[] = [];
  let i = 0;
  while (i < buf.length) {
    const len = parseInt(buf.subarray(i, i + 4).toString(), 16);
    if (len === 0) break;
    lines.push(buf.subarray(i + 4, i + len).toString());
    i += len;
  }
  return lines;
}

function handleGitUploadPack(req: IncomingMessage, res: ServerResponse, owner: string, name: string): void {
  const repo = getRepo(owner, name);
  if (!repo) return sendJson(res, 404, { message: "Not Found" });
  
  const url = parseUrl(req.url || "", true);
  if (req.method === "GET" && url.query?.service === "git-upload-pack") {
    // Advertisement
    const head = repo.refs.get("refs/heads/main") || "0".repeat(40);
    const caps = "multi_ack_detailed thin-pack side-band-64k ofs-delta agent=git/2.0";
    let adv = `# service=git-upload-pack\n`;
    adv += `0000`;
    adv += `${head} refs/heads/main\0${caps}\n`;
    adv += `0000`;
    sendText(res, 200, adv, GIT_UPLOAD_PACK);
  } else if (req.method === "POST" && url.query?.service === "git-upload-pack") {
    // Upload pack request - simplified
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      // Just acknowledge for now
      sendText(res, 200, "0000", GIT_UPLOAD_PACK_RESULT);
    });
  } else {
    sendJson(res, 404, { message: "Not Found" });
  }
}

function handleGitReceivePack(req: IncomingMessage, res: ServerResponse, owner: string, name: string): void {
  const repo = getRepo(owner, name);
  if (!repo) return sendJson(res, 404, { message: "Not Found" });
  
  const url = parseUrl(req.url || "", true);
  if (req.method === "GET" && url.query?.service === "git-receive-pack") {
    const head = repo.refs.get("refs/heads/main") || "0".repeat(40);
    const caps = "report-status side-band-64k delete-refs";
    let adv = `# service=git-receive-pack\n`;
    adv += `0000`;
    adv += `${head} refs/heads/main\0${caps}\n`;
    adv += `0000`;
    sendText(res, 200, adv, GIT_RECEIVE_PACK);
  } else if (req.method === "POST" && url.query?.service === "git-receive-pack") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      sendText(res, 200, "0000unpack ok\n0000", GIT_RECEIVE_PACK_RESULT);
    });
  } else {
    sendJson(res, 404, { message: "Not Found" });
  }
}

function handleREST(req: IncomingMessage, res: ServerResponse, path: string, method: string): void {
  const user = auth(req);
  if (!user && path !== "/api/v3" && path !== "/api/v3/") {
    return res.writeHead(401, { "content-type": JSON_TYPE }).end(JSON.stringify({ message: "Requires authentication" }) + "\n");
  }
  
  const parts = path.split("/").filter(Boolean);
  
  // GET /api/v3
  if ((path === "/api/v3" || path === "/api/v3/") && method === "GET") {
    return sendJson(res, 200, { current_user_url: "/api/v3/user", rate_limit_url: "/api/v3/rate_limit" }, { "x-oauth-scopes": "repo, read:org" });
  }
  
  // GET /api/v3/meta
  if (path === "/api/v3/meta" && method === "GET") {
    return sendJson(res, 200, { installed_version: "1.0.0" });
  }
  
  // GET /api/v3/user/repos
  if (path === "/api/v3/user/repos" && method === "GET") {
    const list = Array.from(repos.values()).filter(r => r.owner === user).map(r => ({
      id: createHash("sha1").update(r.owner + "/" + r.name).digest("hex").slice(0, 10),
      name: r.name, full_name: `${r.owner}/${r.name}`, owner: { login: r.owner },
      private: r.private, description: r.description, default_branch: r.default_branch,
      html_url: `https://github.com/${r.owner}/${r.name}`, clone_url: `https://github.com/${r.owner}/${r.name}.git`,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    }));
    return sendJson(res, 200, list, { "link": "<https://api.github.com/user/repos?page=2>; rel=\"next\"" });
  }
  
  // POST /api/v3/user/repos
  if (path === "/api/v3/user/repos" && method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      const { name, description, private: private_ } = JSON.parse(body || "{}");
      if (!name) return sendJson(res, 422, { message: "Validation Failed" });
      const repo = createRepo(user, name, description || null, private_ || false);
      return sendJson(res, 201, {
        id: createHash("sha1").update(user + "/" + name).digest("hex").slice(0, 10),
        name, full_name: `${user}/${name}`, owner: { login: user },
        private: private_ || false, description: description || null, default_branch: "main",
        html_url: `https://github.com/${user}/${name}`, clone_url: `https://github.com/${user}/${name}.git`,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      });
    });
    return;
  }
  
  // Repo routes
  if (parts[0] === "api" && parts[1] === "v3" && parts[2] === "repos" && parts.length >= 4) {
    const [, , , rOwner, rName, ...rest] = parts;
    const repo = getRepo(rOwner, rName);
    if (!repo) return sendJson(res, 404, { message: "Not Found" });
    
    // GET /api/v3/repos/{owner}/{repo}
    if (rest.length === 0 && method === "GET") {
      return sendJson(res, 200, {
        id: createHash("sha1").update(rOwner + "/" + rName).digest("hex").slice(0, 10),
        name: rName, full_name: `${rOwner}/${rName}`, owner: { login: rOwner },
        private: repo.private, description: repo.description, default_branch: repo.default_branch,
        html_url: `https://github.com/${rOwner}/${rName}`, clone_url: `https://github.com/${rOwner}/${rName}.git`,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      });
    }
    
    // PATCH /api/v3/repos/{owner}/{repo}
    if (rest.length === 0 && method === "PATCH") {
      let body = "";
      req.on("data", c => body += c);
      req.on("end", () => {
        const { description } = JSON.parse(body || "{}");
        if (description !== undefined) repo.description = description;
        return sendJson(res, 200, { description: repo.description });
      });
      return;
    }
    
    // DELETE /api/v3/repos/{owner}/{repo}
    if (rest.length === 0 && method === "DELETE") {
      repos.delete(repoKey(rOwner, rName));
      return res.writeHead(204).end();
    }
    
    // Contents
    if (rest[0] === "contents" && method === "PUT") {
      const filePath = rest.slice(1).join("/");
      let body = "";
      req.on("data", c => body += c);
      req.on("end", () => {
        const { content, sha, message } = JSON.parse(body || "{}");
        const newSha = sha1(Buffer.from(content || "", "base64"));
        if (sha && sha !== "0".repeat(40) && sha !== newSha) return sendJson(res, 409, { message: "sha mismatch" });
        return sendJson(res, sha ? 200 : 201, { content: { sha: newSha, path: filePath }, commit: { sha: newSha } });
      });
      return;
    }
    if (rest[0] === "contents" && method === "DELETE") {
      return sendJson(res, 200, { commit: { sha: "0".repeat(40) } });
    }
    
    // Labels
    if (rest[0] === "labels" && method === "POST") {
      let body = "";
      req.on("data", c => body += c);
      req.on("end", () => {
        const { name, color, description } = JSON.parse(body || "{}");
        repo.labels.set(name, { name, color: color || "ffffff", description: description || null });
        return sendJson(res, 201, { name, color: color || "ffffff", description: description || null });
      });
      return;
    }
    
    // Issues
    if (rest[0] === "issues" && method === "POST") {
      let body = "";
      req.on("data", c => body += c);
      req.on("end", () => {
        const { title, body: issueBody, labels } = JSON.parse(body || "{}");
        if (labels) {
          for (const l of labels) if (!repo.labels.has(l)) return sendJson(res, 422, { message: `Label ${l} does not exist` });
        }
        const num = repo.next_issue++;
        const issue: Issue = { number: num, title, body: issueBody || null, state: "open", labels: labels || [], user: { login: user }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        repo.issues.set(num, issue);
        return sendJson(res, 201, issue);
      });
      return;
    }
    
    // Pulls
    if (rest[0] === "pulls" && method === "POST") {
      let body = "";
      req.on("data", c => body += c);
      req.on("end", () => {
        const { title, head, base, body: pullBody } = JSON.parse(body || "{}");
        const num = repo.next_pull++;
        const pull: PullRequest = { number: num, title, body: pullBody || null, state: "open", head: { ref: head, sha: "0".repeat(40), repo: { full_name: `${rOwner}/${rName}` } }, base: { ref: base, sha: "0".repeat(40), repo: { full_name: `${rOwner}/${rName}` } }, user: { login: user }, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), merged_at: null, merge_commit_sha: null };
        repo.pulls.set(num, pull);
        return sendJson(res, 201, pull);
      });
      return;
    }
    
    // GET pull
    if (rest[0] === "pulls" && rest[1] && method === "GET") {
      const num = parseInt(rest[1]);
      const pull = repo.pulls.get(num);
      if (!pull) return sendJson(res, 404, { message: "Not Found" });
      return sendJson(res, 200, pull);
    }
    
    // Merge pull
    if (rest[0] === "pulls" && rest[1] && rest[2] === "merge" && method === "PUT") {
      const num = parseInt(rest[1]);
      const pull = repo.pulls.get(num);
      if (!pull) return sendJson(res, 404, { message: "Not Found" });
      if (pull.state !== "open") return sendJson(res, 405, { message: "Pull Request is not open" });
      pull.state = "merged";
      pull.merged_at = new Date().toISOString();
      pull.merge_commit_sha = sha1(Buffer.from("merge"));
      return sendJson(res, 200, { sha: pull.merge_commit_sha, merged: true, message: "Pull request merged" });
    }
  }
  
  sendJson(res, 404, { message: "Not Found" });
}

function handleGraphQL(req: IncomingMessage, res: ServerResponse): void {
  const user = auth(req);
  if (!user) return res.writeHead(401, { "content-type": JSON_TYPE }).end(JSON.stringify({ errors: [{ message: "Unauthorized" }] }) + "\n");
  
  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => {
    const { query, variables } = JSON.parse(body || "{}");
    if (!query) return sendJson(res, 400, { errors: [{ message: "No query" }] });
    
    // Introspection
    if (query.includes("__schema") || query.includes("__type")) {
      return sendJson(res, 200, {
        data: {
          __schema: {
            types: [
              { name: "Issue", fields: [{ name: "id" }, { name: "number" }, { name: "title" }, { name: "state" }, { name: "body" }] },
              { name: "PullRequest", fields: [{ name: "id" }, { name: "number" }, { name: "title" }, { name: "headRefName" }, { name: "baseRefName" }, { name: "mergeable" }, { name: "state" }, { name: "merged" }, { name: "files" }] },
              { name: "Repository", fields: [{ name: "id" }, { name: "databaseId" }, { name: "name" }, { name: "nameWithOwner" }, { name: "owner" }, { name: "defaultBranchRef" }, { name: "viewerPermission" }, { name: "hasIssuesEnabled" }, { name: "issue" }, { name: "issues" }, { name: "pullRequests" }, { name: "pullRequest" }] },
              { name: "SearchType", enumValues: [{ name: "ISSUE" }, { name: "REPOSITORY" }] }
            ]
          }
        }
      });
    }
    
    // Basic query responses
    if (query.includes("repository(")) {
      const match = query.match(/repository\(owner:\s*"([^"]+)",\s*name:\s*"([^"]+)"\)/);
      if (match) {
        const [, o, n] = match;
        const repo = getRepo(o, n);
        if (repo) {
          return sendJson(res, 200, { data: { repository: { id: "1", databaseId: 1, name: n, nameWithOwner: `${o}/${n}`, owner: { login: o }, defaultBranchRef: { name: "main" }, viewerPermission: "ADMIN", hasIssuesEnabled: true } } });
        }
        return sendJson(res, 200, { data: { repository: null } });
      }
    }
    
    if (query.includes("createPullRequest")) {
      return sendJson(res, 200, { data: { createPullRequest: { pullRequest: { number: 1, headRefName: variables?.headRefName, baseRefName: variables?.baseRefName, state: "OPEN" } } } });
    }
    
    sendJson(res, 200, { data: {} });
  });
}

function handleMCP(req: IncomingMessage, res: ServerResponse): void {
  const user = auth(req);
  if (!user) return res.writeHead(401, { "content-type": JSON_TYPE }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32600, message: "Unauthorized" }, id: null }) + "\n");
  
  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => {
    const msg = JSON.parse(body || "{}");
    const { method, params, id } = msg;
    
    if (method === "initialize") {
      return sendJson(res, 200, { jsonrpc: "2.0", result: { protocolVersion: "2026-07-28", capabilities: { tools: {} }, serverInfo: { name: "github-forge", version: "1.0.0" } }, id });
    }
    if (method === "tools/list") {
      return sendJson(res, 200, { jsonrpc: "2.0", result: { tools: [
        { name: "create_repo", description: "Create a repository", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
        { name: "get_repo", description: "Get a repository", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"] } },
        { name: "create_issue", description: "Create an issue", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" } }, required: ["owner", "repo", "title"] } },
        { name: "list_issues", description: "List issues", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, state: { type: "string" } }, required: ["owner", "repo"] } },
        { name: "create_pull_request", description: "Create a pull request", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, head: { type: "string" }, base: { type: "string" } }, required: ["owner", "repo", "title", "head", "base"] } },
        { name: "merge_pull_request", description: "Merge a pull request", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, pull_number: { type: "number" } }, required: ["owner", "repo", "pull_number"] } }
      ] }, id });
    }
    if (method === "tools/call") {
      const { name, arguments: args } = params || {};
      let result: any = {};
      if (name === "create_repo") {
        const repo = createRepo(user, args.name, null, false);
        result = { id: "1", name: repo.name, full_name: `${user}/${repo.name}` };
      } else if (name === "get_repo") {
        const repo = getRepo(args.owner, args.repo);
        result = repo ? { id: "1", name: repo.name, full_name: `${args.owner}/${repo.name}` } : null;
      } else if (name === "create_issue") {
        const repo = getRepo(args.owner, args.repo);
        if (repo) {
          const num = repo.next_issue++;
          const issue: Issue = { number: num, title: args.title, body: args.body || null, state: "open", labels: [], user: { login: user }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
          repo.issues.set(num, issue);
          result = issue;
        }
      } else if (name === "list_issues") {
        const repo = getRepo(args.owner, args.repo);
        result = repo ? Array.from(repo.issues.values()).filter(i => !args.state || i.state === args.state) : [];
      } else if (name === "create_pull_request") {
        const repo = getRepo(args.owner, args.repo);
        if (repo) {
          const num = repo.next_pull++;
          const pull: PullRequest = { number: num, title: args.title, body: null, state: "open", head: { ref: args.head, sha: "0".repeat(40), repo: { full_name: `${args.owner}/${args.repo}` } }, base: { ref: args.base, sha: "0".repeat(40), repo: { full_name: `${args.owner}/${args.repo}` } }, user: { login: user }, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), merged_at: null, merge_commit_sha: null };
          repo.pulls.set(num, pull);
          result = pull;
        }
      } else if (name === "merge_pull_request") {
        const repo = getRepo(args.owner, args.repo);
        const pull = repo?.pulls.get(args.pull_number);
        if (pull) { pull.state = "merged"; pull.merged_at = new Date().toISOString(); result = { merged: true }; }
      }
      return sendJson(res, 200, { jsonrpc: "2.0", result: { content: [{ type: "text", text: JSON.stringify(result) }] }, id });
    }
    sendJson(res, 200, { jsonrpc: "2.0", error: { code: -32601, message: "Method not found" }, id });
  });
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = parseUrl(req.url || "", true);
    const path = url.pathname || "/";
    const method = req.method || "GET";
    
    if (method === "GET" && path === "/healthz") {
      return sendJson(res, 200, { ok: true });
    }
    
    // Git smart HTTP
    const gitMatch = path.match(/^\/([^\/]+)\/([^\/]+)\.git\/(.*)$/);
    if (gitMatch) {
      const [, owner, name, rest] = gitMatch;
      const subPath = "/" + rest;
      const req2 = Object.assign({}, req, { url: subPath });
      if (subPath.includes("git-upload-pack")) return handleGitUploadPack(req2 as any, res, owner, name);
      if (subPath.includes("git-receive-pack")) return handleGitReceivePack(req2 as any, res, owner, name);
      return sendJson(res, 404, { message: "Not Found" });
    }
    
    // REST API
    if (path.startsWith("/api/v3")) return handleREST(req, res, path, method);
    if (path.startsWith("/api/graphql")) return handleGraphQL(req, res);
    if (path.startsWith("/mcp")) return handleMCP(req, res);
    
    sendJson(res, 404, { message: "Not Found" });
  });
}