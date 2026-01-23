import http from "http";
import fs from "fs";
import path from "path";
import { Logger } from "./Logger";
import { EventEmitter } from "events";

export class VerificationServer {
  private server: http.Server | null = null;
  private logger = new Logger("VerifyServer");
  private host = process.env.VERIFY_HOST || "0.0.0.0";
  private port = Number(process.env.VERIFY_PORT) || 3838;

  private static events = new EventEmitter();
  private static results = new Map<string, any>();

  constructor(port?: number) {
    if (port) this.port = port;
  }

  public static onResult(sessionId: string, callback: (result: any) => void) {
    this.events.once(`result:${sessionId}`, callback);
  }

  public static getResult(sessionId: string): any {
    const result = this.results.get(sessionId);
    if (result) {
      this.results.delete(sessionId);
    }
    return result;
  }

  public start() {
    this.server = http.createServer((req, res) => {
      const url = new URL(req.url || "", `http://localhost:${this.port}`);

      if (req.method === "GET" && url.pathname === "/verify") {
        const filePath = path.resolve("./verify.html");
        fs.readFile(filePath, (err, data) => {
          if (err) {
            res.writeHead(500);
            res.end("Error loading verify.html");
            return;
          }
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(data);
        });
      } else if (req.method === "POST" && url.pathname === "/callback") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            const data = JSON.parse(body);
            if (data.sessionId && data.result) {
              VerificationServer.results.set(data.sessionId, data.result);
              VerificationServer.events.emit(
                `result:${data.sessionId}`,
                data.result,
              );

              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: true }));
              this.logger.info(
                `Received captcha result for session: ${data.sessionId}`,
              );
            } else {
              res.writeHead(400);
              res.end("Missing parameters");
            }
          } catch (e) {
            res.writeHead(400);
            res.end("Invalid JSON");
          }
        });
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });

    this.server.listen(this.port, this.host, () => {
      this.logger.info(
        `Verification server running at http://${this.host}:${this.port}/verify`,
      );
    });
  }

  public stop() {
    if (this.server) {
      this.server.close();
    }
  }
}
