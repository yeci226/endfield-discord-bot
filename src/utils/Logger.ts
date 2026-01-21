import colors from "colors";
import moment from "moment";

export class Logger {
  private scope: string;

  constructor(scope: string) {
    this.scope = scope;
  }

  public log(message: string): void {
    console.log(
      `[${moment().format("YYYY-MM-DD HH:mm:ss")}] [${this.scope}] ${message}`,
    );
  }

  public info(message: string): void {
    console.log(
      `[${moment().format("YYYY-MM-DD HH:mm:ss")}] [${this.scope}] ${colors.green("INFO")} ${message}`,
    );
  }

  public warn(message: string): void {
    console.log(
      `[${moment().format("YYYY-MM-DD HH:mm:ss")}] [${this.scope}] ${colors.yellow("WARN")} ${message}`,
    );
  }

  public error(message: string): void {
    console.log(
      `[${moment().format("YYYY-MM-DD HH:mm:ss")}] [${this.scope}] ${colors.red("ERROR")} ${message}`,
    );
  }

  public success(message: string): void {
    console.log(
      `[${moment().format("YYYY-MM-DD HH:mm:ss")}] [${this.scope}] ${colors.green("SUCCESS")} ${message}`,
    );
  }

  public debug(message: string): void {
    console.log(
      `[${moment().format("YYYY-MM-DD HH:mm:ss")}] [${this.scope}] ${colors.blue("DEBUG")} ${message}`,
    );
  }
}
