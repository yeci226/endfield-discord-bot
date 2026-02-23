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

  public info(message: any, ...optionalParams: any[]): void {
    console.log(
      `${this.getTimestamp()} ${colors.cyan(`[${this.scope}]`)}`,
      message,
      ...optionalParams,
    );
  }

  public success(message: any, ...optionalParams: any[]): void {
    console.log(
      `${this.getTimestamp()} ${colors.green(`[${this.scope}]`)}`,
      message,
      ...optionalParams,
    );
  }

  public warn(message: any, ...optionalParams: any[]): void {
    console.log(
      `${this.getTimestamp()} ${colors.yellow(`[${this.scope}]`)}`,
      message,
      ...optionalParams,
    );
  }

  public error(message: any, ...optionalParams: any[]): void {
    console.log(
      `${this.getTimestamp()} ${colors.red(`[${this.scope}]`)}`,
      message,
      ...optionalParams,
    );
  }

  public debug(message: any, ...optionalParams: any[]): void {
    console.log(
      `${this.getTimestamp()} ${colors.magenta(`[${this.scope}]`)}`,
      message,
      ...optionalParams,
    );
  }

  public log(message: any, ...optionalParams: any[]): void {
    this.info(message, ...optionalParams);
  }
}
