import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { ExtendedClient } from "../structures/Client";
import { Logger } from "../utils/Logger";
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
import crypto from "crypto";
import axios from "axios";

export class WebManager {
  private app = express();
  private logger = new Logger("WebManager");
  private client: ExtendedClient;
  private rootDir = path.join(
    __dirname,
    fs.existsSync(path.join(__dirname, "../../src")) ? "../../src" : "../..",
  );
  private dataCache = new Map<string, { data: any; expires: number }>();

  constructor(client: ExtendedClient) {
    this.client = client;
    this.setup();
  }

  private setup() {
    this.app.use(cors());
    this.app.use(bodyParser.json({ limit: "10mb" }));
    this.app.use((req, res, next) => {
      this.logger.info(`${req.method} ${req.url}`);
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

    this.app.use("/endfield/assets", express.static(assetsPath, staticOptions));
    this.app.use("/assets", express.static(assetsPath, staticOptions));
    this.app.use("/endfield", express.static(publicPath, { maxAge: "1h" }));
    this.app.use("/", express.static(publicPath, { maxAge: "1h" }));

    // Health Checks
    const healthHandler = (req: express.Request, res: express.Response) => {
      res.send(`
        <html>
          <body style="background:#111; color:#eee; font-family:sans-serif; display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh;">
            <h1 style="color:#00ff88;">Endfield Web Manager is UP</h1>
            <p>Cluster: ${this.client.cluster?.id ?? "N/A"}</p>
            <p>Path: ${req.originalUrl}</p>
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
    const proxyHandler = async (
      req: express.Request,
      res: express.Response,
    ) => {
      const url = req.query.url as string;
      if (!url) return res.status(400).send("No URL");

      try {
        if (url.startsWith("http")) {
          // Local Disk Cache Logic
          const hash = crypto.createHash("md5").update(url).digest("hex");
          const cacheDir = path.join(this.rootDir, "assets/cache");
          if (!fs.existsSync(cacheDir))
            fs.mkdirSync(cacheDir, { recursive: true });

          const ext = path.extname(new URL(url).pathname) || ".png";
          const cachePath = path.join(cacheDir, `${hash}${ext}`);

          if (fs.existsSync(cachePath)) {
            return res.sendFile(cachePath);
          }

          const response = await axios.get(url, {
            responseType: "arraybuffer",
          });
          const buffer = Buffer.from(response.data);
          const contentType = response.headers["content-type"];

          await fs.promises.writeFile(cachePath, buffer);

          if (contentType) res.setHeader("Content-Type", String(contentType));
          res.setHeader("Cache-Control", "public, max-age=604800, immutable");
          res.send(buffer);
        } else {
          res.status(404).send("Not found");
        }
      } catch (e) {
        this.logger.error(`Proxy error for ${url}: ${e}`);
        res.status(500).send("Proxy error");
      }
    };
    this.app.get("/api/proxy", proxyHandler);
    this.app.get("/endfield/api/proxy", proxyHandler);

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
      const session = await this.client.db.get(`profile_edit_token:${token}`);
      if (!session || session.expiresAt < Date.now()) {
        return res.status(401).json({ error: "Invalid or expired token" });
      }

      // Memory Cache Check
      const cached = this.dataCache.get(token);
      if (cached && cached.expires > Date.now()) {
        return res.json(cached.data);
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
      this.dataCache.set(token, {
        data: responseData,
        expires: Date.now() + 120000,
      });

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
      const session = await this.client.db.get(`profile_edit_token:${token}`);
      if (!session || session.expiresAt < Date.now()) {
        return res.status(401).json({ error: "Invalid or expired token" });
      }
      const { template } = req.body;
      if (template === null) {
        await this.client.db.delete(`profile.${session.userId}.template`);
        return res.json({ success: true });
      }
      if (!template) return res.status(400).json({ error: "Missing template" });
      await ProfileTemplateService.saveUserTemplate(
        this.client.db,
        session.userId,
        template,
      );
      res.json({ success: true });
    };
    this.app.post("/api/profile/:token", saveProfileHandler);
    this.app.post("/endfield/api/profile/:token", saveProfileHandler);

    // API: Render preview image using actual drawDashboard()
    const previewHandler = async (
      req: express.Request,
      res: express.Response,
    ) => {
      const token = req.params.token as string;
      const session = await this.client.db.get(`profile_edit_token:${token}`);
      if (!session || session.expiresAt < Date.now()) {
        return res.status(401).json({ error: "Invalid or expired token" });
      }

      const cached = this.dataCache.get(token);
      if (!cached) {
        return res.status(404).json({ error: "No data cached, reload the editor page first" });
      }

      const { template: bodyTemplate } = req.body;
      if (!bodyTemplate) {
        return res.status(400).json({ error: "Missing template" });
      }

      const detail = cached.data.detail;
      if (!detail) {
        return res.status(404).json({ error: "No card detail available" });
      }

      try {
        const locale = cached.data.user?.locale || "tw";
        const tr = createTranslator(locale);
        const buffer = await drawDashboard(detail, tr, bodyTemplate);
        res.setHeader("Content-Type", "image/webp");
        res.setHeader("Cache-Control", "no-store");
        res.send(buffer);
      } catch (err: any) {
        this.logger.error(`Preview render failed: ${err.message}`);
        res.status(500).json({ error: "Render failed", detail: err.message });
      }
    };
    this.app.post("/api/preview/:token", previewHandler);
    this.app.post("/endfield/api/preview/:token", previewHandler);

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
    const callbackHandler = async (
      req: express.Request,
      res: express.Response,
    ) => {
      const { sessionId, result } = req.body;
      const { VerificationClient } = require("./VerificationClient");
      if (sessionId && result) {
        VerificationClient.emitResult(sessionId, result);
        this.logger.success(
          `Verification result received locally for ${sessionId}`,
        );
        res.json({ success: true });
      } else {
        res
          .status(400)
          .json({ success: false, message: "Missing sessionId or result" });
      }
    };
    this.app.post("/callback", callbackHandler);
    this.app.post("/endfield/callback", callbackHandler);

    // Catch-all for debugging 404
    this.app.use((req, res) => {
      this.logger.warn(`404 Not Found: ${req.method} ${req.originalUrl}`);
      res.status(404).json({
        error: "Not Found",
        path: req.originalUrl,
        method: req.method,
        clusterId: this.client.cluster?.id,
        note: "Endfield WebManager Debug 404",
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
