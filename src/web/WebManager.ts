import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { ExtendedClient } from "../structures/Client";
import { Logger } from "../utils/Logger";
import { resolveOwnAssetRel } from "../utils/ownAssets";
import { ProfileTemplateService } from "../services/ProfileTemplateService";
import { getCardDetail } from "../utils/skportApi";
import {
  getAccounts,
  ensureAccountBinding,
  getPrimaryBindingRole,
  withAutoRefresh,
} from "../utils/accountUtils";
import { drawDashboard } from "../utils/canvasUtils";
import { createTranslator } from "../utils/i18n";
import fs from "fs";
import path from "path";
import type { NextFunction, Request, Response } from "express";
import {
  evictCache,
  fetchProxiedImage,
  findCached,
  isServableCacheFile,
  ProxyError,
  writeCached,
} from "./imageProxy";
import { VerificationClient } from "./VerificationClient";
import { validateTemplateImages } from "./templateGuard";
import {
  BoundedCache,
  createRateLimiter,
  isPlausibleToken,
  maskTokensInUrl,
  parseAllowedOrigins,
  RateLimiter,
  resolveClientIp,
} from "./webSecurity";

const HOUR_MS = 60 * 60 * 1000;

export class WebManager {
  private app = express();
  private logger = new Logger("WebManager");
  private client: ExtendedClient;
  private rootDir = path.join(
    __dirname,
    fs.existsSync(path.join(__dirname, "../../src")) ? "../../src" : "../..",
  );
  /** Editor data per edit token: max 200 entries, dropped when the token expires. */
  private dataCache = new BoundedCache<any>(200);
  private cacheDir = path.join(this.rootDir, "assets/cache");

  private callbackLimiter = createRateLimiter({ limit: 30, windowMs: 60_000 });
  private previewLimiter = createRateLimiter({ limit: 30, windowMs: 60_000 });
  private proxyLimiter = createRateLimiter({ limit: 120, windowMs: 60_000 });

  constructor(client: ExtendedClient) {
    this.client = client;
    this.setup();

    // Hourly housekeeping (cluster 0 only, via the startup hooks)
    client.startup.every("web-purge-edit-tokens", HOUR_MS, () => {
      this.purgeExpiredEditTokens();
    });
    client.startup.every("web-evict-proxy-cache", HOUR_MS, () => {
      const n = evictCache(this.cacheDir);
      if (n > 0) this.logger.info(`Proxy cache: evicted ${n} file(s)`);
    });
  }

  /** Deletes expired profile_edit_token:* rows. */
  private purgeExpiredEditTokens() {
    const now = Date.now();
    const rows = this.client.db.findFieldByPrefix(
      "profile_edit_token:",
      "$.expiresAt",
    );
    let n = 0;
    for (const row of rows) {
      // LIKE treats "_" as a wildcard and ignores case: re-check the prefix
      if (!row.id.startsWith("profile_edit_token:")) continue;
      const exp = Number(row.field);
      if (!Number.isFinite(exp) || exp < now) {
        void this.client.db.delete(row.id);
        n++;
      }
    }
    if (n > 0) this.logger.info(`Purged ${n} expired editor token(s)`);
  }

  /** Looks up a live edit session; expired rows are deleted on the way. */
  private async loadSession(
    token: unknown,
  ): Promise<{ userId: string; expiresAt: number } | null> {
    if (!isPlausibleToken(token)) return null;
    const key = `profile_edit_token:${token}`;
    const session = await this.client.db.get(key);
    if (!session || typeof session.expiresAt !== "number") return null;
    if (session.expiresAt < Date.now()) {
      void this.client.db.delete(key);
      return null;
    }
    return session;
  }

  private limit(limiter: RateLimiter) {
    return (req: Request, res: Response, next: NextFunction) => {
      const ip = resolveClientIp(
        req.socket.remoteAddress,
        req.headers["x-forwarded-for"],
      );
      const r = limiter.check(ip);
      if (r.allowed) return next();
      res.setHeader("Retry-After", String(Math.ceil(r.retryAfterMs / 1000)));
      res.status(429).json({ error: "Too many requests" });
    };
  }

  private setup() {
    this.app.disable("x-powered-by");
    const allowedOrigins = parseAllowedOrigins(process.env.WEB_ALLOWED_ORIGINS);
    // Same-origin only unless WEB_ALLOWED_ORIGINS lists other origins.
    this.app.use(
      cors({
        origin: (origin, cb) =>
          cb(null, !!origin && allowedOrigins.includes(origin)),
      }),
    );
    const json2mb = bodyParser.json({ limit: "2mb" });
    const json32kb = bodyParser.json({ limit: "32kb" });
    this.app.use((req, res, next) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      this.logger.info(`${req.method} ${maskTokensInUrl(req.originalUrl)}`);
      next();
    });
    // Simplified Static Middleware
    const publicPath = path.join(this.rootDir, "web/public");
    const assetsPath = path.join(this.rootDir, "assets");

    // Static Middleware with Cache-Control
    const staticOptions = {
      maxAge: "1d",
      immutable: true,
    };

    // assets/cache only ever serves images (never .html/.svg/.js)
    const guardCache = (req: Request, res: Response, next: NextFunction) => {
      let p: string;
      try {
        p = path.posix.normalize(decodeURIComponent(req.path)).toLowerCase();
      } catch {
        return res.status(400).end();
      }
      if (/^\/+cache(\/|$)/.test(p) && !isServableCacheFile(p)) {
        return res.status(404).end();
      }
      next();
    };
    this.app.use(
      "/endfield/assets",
      guardCache,
      express.static(assetsPath, staticOptions),
    );
    this.app.use(
      "/assets",
      guardCache,
      express.static(assetsPath, staticOptions),
    );
    this.app.use("/endfield", express.static(publicPath, { maxAge: "1h" }));
    this.app.use("/", express.static(publicPath, { maxAge: "1h" }));

    // Health Checks
    const healthHandler = (req: express.Request, res: express.Response) => {
      res.send(`
        <html>
          <body style="background:#111; color:#eee; font-family:sans-serif; display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh;">
            <h1 style="color:#00ff88;">Endfield Web Manager is UP</h1>
            <p>Cluster: ${this.client.cluster?.id ?? "N/A"}</p>
            <p>Time: ${new Date().toLocaleString()}</p>
            <hr style="width:200px; border-color:#333;">
            <a href="/profile/edit" style="color:#00bcd4;">Go to Editor (Root Path)</a><br>
            <a href="/endfield/profile/edit" style="color:#00bcd4; margin-top:10px;">Go to Editor (/endfield Path)</a>
          </body>
        </html>
      `);
    };
    this.app.get("/", healthHandler);
    this.app.get("/endfield", healthHandler);

    // API: Proxy for images (CORS bypass)
    const proxyHandler = async (req: Request, res: Response) => {
      const url = req.query.url;
      if (typeof url !== "string" || !url) {
        return res.status(400).send("Bad request");
      }

      // The editor routes every absolute image link through this proxy,
      // including links to our own /assets saved under an older domain.
      const ownRel = resolveOwnAssetRel(url);
      if (ownRel) {
        return res.redirect(
          302,
          "/assets/" + ownRel.split("/").map(encodeURIComponent).join("/"),
        );
      }

      try {
        const cached = findCached(this.cacheDir, url);
        if (cached) {
          res.setHeader("Cache-Control", "public, max-age=604800, immutable");
          return res.sendFile(cached);
        }

        const img = await fetchProxiedImage(url);
        await writeCached(this.cacheDir, url, img);

        res.setHeader("Content-Type", img.contentType);
        res.setHeader("Cache-Control", "public, max-age=604800, immutable");
        res.send(img.buffer);
      } catch (e) {
        if (e instanceof ProxyError) {
          this.logger.warn(`Proxy refused (${e.reason}): ${url.slice(0, 200)}`);
          return res
            .status(e.status === 400 ? 400 : 502)
            .send(e.status === 400 ? "Bad request" : "Proxy error");
        }
        this.logger.error(`Proxy error: ${e}`);
        res.status(502).send("Proxy error");
      }
    };
    const proxyLimit = this.limit(this.proxyLimiter);
    this.app.get("/api/proxy", proxyLimit, proxyHandler);
    this.app.get("/endfield/api/proxy", proxyLimit, proxyHandler);

    // List illustrators
    const illustratorsHandler = async (
      req: express.Request,
      res: express.Response,
    ) => {
      try {
        const dir = path.join(__dirname, "../assets/illustrators");
        if (!fs.existsSync(dir)) return res.json([]);
        const files = await fs.promises.readdir(dir);
        const images = files.filter(
          (f: string) =>
            f.toLowerCase().endsWith(".png") ||
            f.toLowerCase().endsWith(".jpg"),
        );
        res.json(images);
      } catch (e) {
        res.status(500).json({ error: "Failed to list illustrators" });
      }
    };
    this.app.get("/api/illustrators", illustratorsHandler);
    this.app.get("/endfield/api/illustrators", illustratorsHandler);

    // API: Get data for editor
    const getProfileHandler = async (
      req: express.Request,
      res: express.Response,
    ) => {
      const token = req.params.token as string;
      const session = await this.loadSession(token);
      if (!session) {
        return res.status(401).json({ error: "Invalid or expired token" });
      }

      // Memory Cache Check
      const cached = this.dataCache.get(token);
      if (cached) {
        return res.json(cached);
      }

      const userId = session.userId;
      const template = await ProfileTemplateService.getUserTemplate(
        this.client.db,
        userId,
      );
      const accounts = await getAccounts(this.client.db, userId);
      const account = accounts?.[0];
      if (!account) return res.status(404).json({ error: "Account not found" });

      await ensureAccountBinding(account, userId, this.client.db, "tw");
      const primaryBinding = getPrimaryBindingRole(account.roles);
      const role = primaryBinding?.role;
      if (!role) return res.status(404).json({ error: "Role not found" });

      const uid = account.info?.id || primaryBinding?.binding?.uid;
      const cardRes = await withAutoRefresh(
        this.client,
        userId,
        account,
        (c: string, s: string, options: any) =>
          getCardDetail(
            role.roleId,
            role.serverId,
            uid,
            account.locale || "tw",
            c,
            s,
            options,
          ),
        account.locale || "tw",
      ).catch((err) => {
        this.logger.error(`AutoRefresh failed in editor: ${err.message}`);
        return null;
      });

      const responseData = {
        template,
        detail: cardRes?.data?.detail,
        user: { id: userId, username: account.info?.nickname || "User" },
      };

      // Set Cache (2 minutes)
      this.dataCache.set(token, responseData, 120000, session.expiresAt);

      res.json(responseData);
    };
    this.app.get("/api/profile/:token", getProfileHandler);
    this.app.get("/endfield/api/profile/:token", getProfileHandler);

    // API: Save layout
    const saveProfileHandler = async (
      req: express.Request,
      res: express.Response,
    ) => {
      const token = req.params.token;
      const session = await this.loadSession(token);
      if (!session) {
        return res.status(401).json({ error: "Invalid or expired token" });
      }
      const { template } = req.body ?? {};
      if (template === null) {
        await this.client.db.delete(`profile.${session.userId}.template`);
        return res.json({ success: true });
      }
      if (!template) return res.status(400).json({ error: "Missing template" });
      if (!validateTemplateImages(template).ok) {
        return res.status(400).json({ error: "Invalid image source" });
      }
      await ProfileTemplateService.saveUserTemplate(
        this.client.db,
        session.userId,
        template,
      );
      res.json({ success: true });
    };
    this.app.post("/api/profile/:token", json2mb, saveProfileHandler);
    this.app.post("/endfield/api/profile/:token", json2mb, saveProfileHandler);

    // API: Render preview image using actual drawDashboard()
    const previewHandler = async (
      req: express.Request,
      res: express.Response,
    ) => {
      const token = req.params.token as string;
      const session = await this.loadSession(token);
      if (!session) {
        return res.status(401).json({ error: "Invalid or expired token" });
      }

      const cached = this.dataCache.get(token);
      if (!cached) {
        return res
          .status(404)
          .json({ error: "No data cached, reload the editor page first" });
      }

      const { template: bodyTemplate } = req.body ?? {};
      if (!bodyTemplate) {
        return res.status(400).json({ error: "Missing template" });
      }

      if (!validateTemplateImages(bodyTemplate).ok) {
        return res.status(400).json({ error: "Invalid image source" });
      }

      const detail = cached.detail;
      if (!detail) {
        return res.status(404).json({ error: "No card detail available" });
      }

      try {
        const locale = cached.user?.locale || "tw";
        const tr = createTranslator(locale);
        const buffer = await drawDashboard(detail, tr, bodyTemplate);
        res.setHeader("Content-Type", "image/webp");
        res.setHeader("Cache-Control", "no-store");
        res.send(buffer);
      } catch (err: any) {
        this.logger.error(`Preview render failed: ${err.message}`);
        res.status(500).json({ error: "Render failed" });
      }
    };
    const previewLimit = this.limit(this.previewLimiter);
    this.app.post("/api/preview/:token", previewLimit, json2mb, previewHandler);
    this.app.post(
      "/endfield/api/preview/:token",
      previewLimit,
      json2mb,
      previewHandler,
    );

    // Serve HTML
    const editorHandler = (req: express.Request, res: express.Response) => {
      res.sendFile(path.join(this.rootDir, "web/public", "index.html"));
    };
    this.app.get("/profile/edit", editorHandler);
    this.app.get("/endfield/profile/edit", editorHandler);

    const verifyHandler = (req: express.Request, res: express.Response) => {
      res.sendFile(path.join(this.rootDir, "web/public", "verify.html"));
    };
    this.app.get("/verify", verifyHandler);
    this.app.get("/endfield/verify", verifyHandler);

    // Handle verification callback
    const callbackHandler = async (req: Request, res: Response) => {
      const { sessionId, result } = req.body ?? {};
      if (
        typeof sessionId !== "string" ||
        sessionId.length > 64 ||
        !result ||
        typeof result !== "object"
      ) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid request" });
      }
      // Only sessions created by /login are accepted; the waiting cluster
      // picks the result up from the database.
      if (VerificationClient.submitResult(sessionId, result)) {
        this.logger.success("Verification result received");
        res.json({ success: true });
      } else {
        res
          .status(400)
          .json({ success: false, message: "Invalid or expired session" });
      }
    };
    const callbackLimit = this.limit(this.callbackLimiter);
    this.app.post("/callback", callbackLimit, json32kb, callbackHandler);
    this.app.post(
      "/endfield/callback",
      callbackLimit,
      json32kb,
      callbackHandler,
    );

    this.app.use((req, res) => {
      res.status(404).json({ error: "Not Found" });
    });

    // Generic errors only: never leak internals (body-parser 4xx keep their status)
    this.app.use((err: any, req: Request, res: Response, next: NextFunction) => {
      if (res.headersSent) return next(err);
      const status =
        typeof err?.status === "number" && err.status >= 400 && err.status < 500
          ? err.status
          : 500;
      if (status === 500) this.logger.error(`Unhandled web error: ${err}`);
      res.status(status).json({
        error: status === 413 ? "Payload too large" : "Request failed",
      });
    });
  }

  public start() {
    const port = parseInt(process.env.VERIFY_PORT || "3838");
    this.app.listen(port, "0.0.0.0", () => {
      this.logger.success(
        `[Cluster ${this.client.cluster?.id}] Web Editor started on port ${port}`,
      );
    });
  }
}
