// Точка входа для Phusion Passenger на виртуальном хостинге Beget.
//
// Passenger запускает этот файл установленным вручную Node.js и передаёт
// порт через process.env.PORT. Сервер импортирует собранный vinext-worker
// (dist/server/index.js, export default { fetch }) и проксирует в него все
// запросы, которые Apache не нашёл в public_html. Статика из dist/client
// раздаётся напрямую, а для «публичных» файлов — через env.ASSETS.fetch,
// как в tests/rendered-html.test.mjs.
//
// Зависимостей из node_modules нет: сборка vinext самодостаточна
// (dist/server/vinext-externals.json пуст), поэтому на сервер нужны только
// server.js, package.json и каталог dist/.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_ROOT = fileURLToPath(new URL(".", import.meta.url));

// Минимальное чтение .env из корня приложения (KEY=VALUE построчно):
// переменные, уже заданные в process.env (Passenger/SetEnv), приоритетнее.
// Нужно для TG_RELAY_SECRET и TELEGRAM_BOT_TOKEN релея /tg-bot-relay.
function loadEnvFile() {
  let text;
  try {
    text = readFileSync(join(APP_ROOT, ".env"), "utf8");
  } catch {
    return; // .env не обязателен
  }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || line.trimStart().startsWith("#")) continue;
    if (process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}
loadEnvFile();

const CLIENT_DIR = join(APP_ROOT, "dist", "client");
const WORKER_ENTRY = join(APP_ROOT, "dist", "server", "index.js");
const MAX_BODY_BYTES = 5 * 1024 * 1024;
// Все запросы /api/* проксируются в бэкенд (Yandex Cloud API Gateway).
// Нужно для Telegram-входа: его виджет привязан к домену fotli.ru, поэтому
// страница виджета и callback должны открываться с основного домена.
// Optional direct Cloud Functions transport while API Gateway is unavailable.
const API_FUNCTION_ENDPOINT = process.env.API_FUNCTION_ENDPOINT || "";
const API_UPSTREAM = process.env.API_UPSTREAM
  || "https://api.example.invalid";

// Релей исходящих вызовов Telegram Bot API (см. tgBotRelay ниже).
const TG_RELAY_SECRET = process.env.TG_RELAY_SECRET || "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
// Whitelist имени метода: только буквы — релей нельзя превратить
// в универсальный прокси (никаких слэшей/точек/путей).
const TG_BOT_METHOD_RE = /^[A-Za-z]+$/;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".tflite": "application/octet-stream",
  ".mp4": "video/mp4",
};

function contentType(filePath) {
  return MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream";
}

// Раздача статики: принимает Request, абсолютный URL или голый pathname;
// отдаёт файл из dist/client или 404 (тогда запрос уходит worker'у).
async function serveAsset(input) {
  let pathname;
  if (typeof input === "string" && input.startsWith("/")) {
    pathname = input;
  } else {
    try {
      pathname = new URL(typeof input === "string" ? input : input.url).pathname;
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const filePath = normalize(join(CLIENT_DIR, pathname));
  if (filePath !== CLIENT_DIR && !filePath.startsWith(CLIENT_DIR + sep)) {
    return new Response("Not found", { status: 404 });
  }
  try {
    const data = await readFile(filePath);
    const headers = { "Content-Type": contentType(filePath) };
    // Как в dist/client/_headers: хэшированные ассеты кэшируются навсегда.
    if (pathname.includes("/_next/static/")) {
      headers["Cache-Control"] = "public, max-age=31536000, immutable";
    }
    return new Response(data, { status: 200, headers });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("REQUEST_TOO_LARGE"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Релей Bot API: egress Yandex Cloud → api.telegram.org нестабилен
// (периодические таймауты), с Beget — стабильно. Cloud Function шлёт сюда
// {secret, method, payload}; мы вызываем Bot API и возвращаем ответ
// Telegram как есть (HTTP-статус + JSON). Токен бота живёт только здесь,
// в ответы и логи не попадает.
async function tgBotRelay(req, res) {
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  try {
    if (!TG_RELAY_SECRET || !TELEGRAM_BOT_TOKEN) {
      send(503, { ok: false, error: "relay not configured" });
      return;
    }
    let data;
    try {
      data = JSON.parse((await readBody(req)).toString("utf8"));
    } catch {
      send(400, { ok: false, error: "invalid json" });
      return;
    }
    if (data?.secret !== TG_RELAY_SECRET) {
      send(403, { ok: false, error: "forbidden" });
      return;
    }
    const method = String(data?.method || "");
    if (!TG_BOT_METHOD_RE.test(method)) {
      send(400, { ok: false, error: "invalid method" });
      return;
    }
    const upstream = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data.payload ?? {}),
      signal: AbortSignal.timeout(15_000),
    });
    console.log(`tg relay: ${method} -> HTTP ${upstream.status}`);
    const text = await upstream.text();
    res.writeHead(upstream.status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(text);
  } catch (error) {
    console.error("tg relay failed:", error?.message || error);
    send(502, { ok: false, error: "relay upstream failed" });
  }
}

function createHandler(worker) {
  const context = {
    waitUntil(promise) {
      Promise.resolve(promise).catch((error) => console.error("background task failed:", error));
    },
    passThroughOnException() {},
  };
  // Проксирование /api/* на бэкенд: метод, заголовки и тело как есть,
  // ответ (включая Set-Cookie) возвращаем браузеру от имени fotli.ru.
  async function proxyApi(req, res) {
    try {
      const upstreamUrl = new URL(req.url || "/", API_UPSTREAM);
      const headers = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        const lower = name.toLowerCase();
        if (lower === "host" || lower === "connection" || lower === "content-length") continue;
        headers[lower] = Array.isArray(value) ? value.join(", ") : value;
      }
      if (API_FUNCTION_ENDPOINT) {
        const requestUrl = new URL(req.url || "/", "https://fotli.ru");
        const query = Object.fromEntries(requestUrl.searchParams);
        const multiQuery = {};
        for (const key of new Set(requestUrl.searchParams.keys())) {
          multiQuery[key] = requestUrl.searchParams.getAll(key);
        }
        const body = req.method === "GET" || req.method === "HEAD"
          ? Buffer.alloc(0) : await readBody(req);
        const event = {
          version: "2.0",
          httpMethod: req.method,
          path: requestUrl.pathname,
          rawPath: requestUrl.pathname,
          rawQueryString: requestUrl.search.slice(1),
          queryStringParameters: query,
          multiValueQueryStringParameters: multiQuery,
          headers: { ...headers, host: req.headers.host || "fotli.ru" },
          cookies: req.headers.cookie ? req.headers.cookie.split(/;\s*/) : [],
          requestContext: {
            http: { method: req.method, path: requestUrl.pathname,
              sourceIp: req.socket.remoteAddress, protocol: "HTTP/1.1" },
            identity: { sourceIp: req.socket.remoteAddress },
          },
          body: body.toString("base64"),
          isBase64Encoded: true,
        };
        const upstream = await fetch(API_FUNCTION_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(event),
          redirect: "manual",
          signal: AbortSignal.timeout(660_000),
        });
        if (!upstream.ok) throw new Error(`Function invocation HTTP ${upstream.status}`);
        const result = await upstream.json();
        const status = Number(result.statusCode);
        if (!Number.isInteger(status) || status < 200 || status > 599) {
          throw new Error("Invalid function response status");
        }
        const responseHeaders = {};
        const blocked = new Set(["content-length", "content-encoding", "transfer-encoding", "connection"]);
        for (const [name, value] of Object.entries(result.headers || {})) {
          const lower = name.toLowerCase();
          if (!blocked.has(lower) && value != null) responseHeaders[lower] = value;
        }
        for (const [name, values] of Object.entries(result.multiValueHeaders || {})) {
          const lower = name.toLowerCase();
          if (!blocked.has(lower) && Array.isArray(values)) responseHeaders[lower] = values;
        }
        if (Array.isArray(result.cookies) && result.cookies.length) {
          const existing = responseHeaders["set-cookie"];
          responseHeaders["set-cookie"] = [
            ...(Array.isArray(existing) ? existing : existing ? [existing] : []),
            ...result.cookies,
          ];
        }
        const responseBody = Buffer.from(result.body || "", result.isBase64Encoded ? "base64" : "utf8");
        res.writeHead(status, responseHeaders);
        res.end(req.method === "HEAD" ? undefined : responseBody);
        return;
      }
      const init = { method: req.method, headers, redirect: "manual" };
      if (req.method !== "GET" && req.method !== "HEAD") {
        init.body = await readBody(req);
      }
      const upstream = await fetch(upstreamUrl, init);
      const responseHeaders = {};
      for (const [name, value] of upstream.headers) {
        const lower = name.toLowerCase();
        // fetch уже распаковал тело: заголовки про сжатие и длину передавать
        // нельзя, иначе браузер пытается распаковать его повторно и падает
        // с ERR_CONTENT_DECODING_FAILED.
        if (lower === "set-cookie" || lower === "content-encoding" || lower === "content-length" || lower === "transfer-encoding") continue;
        responseHeaders[name] = value;
      }
      const setCookies = upstream.headers.getSetCookie ? upstream.headers.getSetCookie() : [];
      if (setCookies.length) responseHeaders["set-cookie"] = setCookies;
      res.writeHead(upstream.status, responseHeaders);
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      console.error("api proxy failed:", error);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      }
      res.end(JSON.stringify({ ok: false, error: "Сервер временно недоступен. Попробуй через минуту." }));
    }
  }
  return async function handle(req, res) {
    try {
      const target = new URL(req.url || "/", `https://${req.headers.host || "localhost"}`);
      // Релей Bot API — ДО общего proxyApi: этот маршрут обслуживает сам
      // Beget-сервер и в Cloud Function не уходит.
      if (req.method === "POST" && target.pathname === "/tg-bot-relay") {
        await tgBotRelay(req, res);
        return;
      }
      if (target.pathname === "/api" || target.pathname.startsWith("/api/")) {
        await proxyApi(req, res);
        return;
      }
      // Worker делегирует в ASSETS только «публичные» файлы, а /_next/static/*
      // на Cloudflare раздаёт сам assets-биндинг мимо worker'а. Поэтому здесь
      // сначала пробуем отдать файл из dist/client напрямую, и только если его
      // нет — передаём запрос worker'у на рендер.
      if (req.method === "GET" || req.method === "HEAD") {
        const asset = await serveAsset(target.pathname);
        if (asset.status !== 404) {
          res.writeHead(asset.status, Object.fromEntries(asset.headers));
          res.end(req.method === "HEAD" ? undefined : Buffer.from(await asset.arrayBuffer()));
          return;
        }
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const init = { method: req.method, headers };
      if (req.method !== "GET" && req.method !== "HEAD") {
        init.body = await readBody(req);
      }
      const response = await worker.fetch(
        new Request(target, init),
        { ASSETS: { fetch: serveAsset } },
        context,
      );
      // SPA-fallback: клиентские маршруты (/orders, /style/<id>, /profile, …)
      // worker не знает и отвечает 404. Прямой заход или F5 на таком адресе
      // не должен давать 404: для навигационных запросов (GET/HEAD; браузер
      // шлёт Accept: text/html, curl и боты — звёздочку) отдаём главную
      // страницу — нужный экран откроет клиентский роутер по
      // location.pathname. Остальные 404 (например, несуществующие файлы)
      // возвращаем как есть.
      let finalResponse = response;
      if (
        response.status === 404
        && (req.method === "GET" || req.method === "HEAD")
        && /(text\/html|\*\/\*)/.test(String(req.headers.accept || ""))
      ) {
        const spaUrl = new URL(target);
        spaUrl.pathname = "/";
        spaUrl.search = "";
        const spaResponse = await worker.fetch(
          new Request(spaUrl, { method: "GET", headers }),
          { ASSETS: { fetch: serveAsset } },
          context,
        );
        if (spaResponse.status === 200) finalResponse = spaResponse;
      }
      res.writeHead(finalResponse.status, Object.fromEntries(finalResponse.headers));
      res.end(finalResponse.body === null || req.method === "HEAD"
        ? undefined
        : Buffer.from(await finalResponse.arrayBuffer()));
    } catch (error) {
      console.error("request failed:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      }
      res.end("Internal Server Error");
    }
  };
}

async function main() {
  const { default: worker } = await import(pathToFileURL(WORKER_ENTRY).href);
  if (!worker || typeof worker.fetch !== "function") {
    throw new Error("dist/server/index.js не похож на собранный vinext worker (нет export default { fetch })");
  }
  const port = Number(process.env.PORT) || 3000;
  // На виртуальном хостинге Beget слушать можно только 127.0.0.1:
  // listen на ::/0.0.0.0 даёт EPERM. Passenger проксирует на localhost.
  const host = process.env.HOST || "127.0.0.1";
  createServer(createHandler(worker)).listen(port, host, () => {
    console.log(`Fotli frontend listening on http://${host}:${port}`);
  });
}

main().catch((error) => {
  console.error("failed to start:", error);
  process.exit(1);
});
