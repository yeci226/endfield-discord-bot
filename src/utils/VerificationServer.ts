import http from "http";
import fs from "fs";
import path from "path";
import { Logger } from "./Logger";
import { EventEmitter } from "events";

import { ExtendedClient } from "../structures/Client";

export class VerificationServer {
  private server: http.Server | null = null;
  private logger = new Logger("VerifyServer");
  private host = process.env.VERIFY_HOST || "0.0.0.0";
  private port = Number(process.env.VERIFY_PORT) || 3838;
  private clientInstance: ExtendedClient | null = null;
  private static client: ExtendedClient | null = null;

  private static events = new EventEmitter();
  private static results = new Map<string, any>();
  private static pendingSessions = new Set<string>();

  constructor(client?: ExtendedClient, port?: number) {
    if (client) {
      this.clientInstance = client;
      VerificationServer.client = client;
    }
    if (port) this.port = port;
  }

  public static onResult(sessionId: string, callback: (result: any) => void) {
    this.registerSession(sessionId);
    this.events.once(`result:${sessionId}`, callback);
  }

  public static registerSession(sessionId: string) {
    if (this.pendingSessions.has(sessionId)) return;

    this.pendingSessions.add(sessionId);

    // Timeout to prevent leaks (15 minutes)
    setTimeout(
      () => {
        this.pendingSessions.delete(sessionId);
        this.results.delete(sessionId);
      },
      15 * 60 * 1000,
    );

    // Broadcast registration to all clusters (so Cluster 0 knows)
    if (this.client) {
      this.client.cluster.broadcastEval(
        (c: any, context: any) => {
          const VS = (global as any).VerificationServerClass;
          if (VS) VS.innerRegister(context.sessionId);
        },
        { context: { sessionId } },
      );
    }
  }

  /**
   * Internal method for broadcastEval to add without re-broadcasting
   */
  private static innerRegister(sessionId: string) {
    this.pendingSessions.add(sessionId);
    setTimeout(
      () => {
        this.pendingSessions.delete(sessionId);
        this.results.delete(sessionId);
      },
      15 * 60 * 1000,
    );
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
              if (!VerificationServer.pendingSessions.has(data.sessionId)) {
                res.writeHead(404);
                res.end("Invalid Session");
                return;
              }

              VerificationServer.results.set(data.sessionId, data.result);
              VerificationServer.events.emit(
                `result:${data.sessionId}`,
                data.result,
              );
              VerificationServer.pendingSessions.delete(data.sessionId);

              // Broadcast to other clusters
              if (this.clientInstance) {
                this.clientInstance.cluster.broadcastEval(
                  (c: any, context: any) => {
                    const VS = (global as any).VerificationServerClass;
                    if (VS) {
                      VS.innerReceive(context.sessionId, context.result);
                    }
                  },
                  {
                    context: {
                      sessionId: data.sessionId,
                      result: data.result,
                    },
                  },
                );
              }

              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: true }));
              // Use debug or success only for valid sessions
              this.logger.success(
                `Successfully processed captcha for session: ${data.sessionId}`,
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

  /**
   * Internal method for broadcastEval to receive result
   */
  private static innerReceive(sessionId: string, result: any) {
    this.results.set(sessionId, result);
    this.events.emit(`result:${sessionId}`, result);
    this.pendingSessions.delete(sessionId);
  }
}

(global as any).VerificationServerClass = VerificationServer;
