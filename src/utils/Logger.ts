import colors from "colors";
import moment from "moment";

export class Logger {
  private scope: string;

  constructor(scope: string) {
    this.scope = scope;
  }

  private getTimestamp(): string {
    return colors.grey(`[${moment().format("YYYY-MM-DD HH:mm:ss")}]`);
  }

  public info(message: string): void {
    console.log(
      `${this.getTimestamp()} ${colors.cyan(`[${this.scope}]`)} ${message}`,
    );
  }

  public success(message: string): void {
    console.log(
      `${this.getTimestamp()} ${colors.green(`[${this.scope}]`)} ${message}`,
    );
  }

  public warn(message: string): void {
    console.log(
      `${this.getTimestamp()} ${colors.yellow(`[${this.scope}]`)} ${message}`,
    );
  }

  public error(message: string): void {
    console.log(
      `${this.getTimestamp()} ${colors.red(`[${this.scope}]`)} ${message}`,
    );
  }

  public debug(message: string): void {
    console.log(
      `${this.getTimestamp()} ${colors.magenta(`[${this.scope}]`)} ${message}`,
    );
  }

  public log(message: string): void {
    this.info(message);
  }
}
