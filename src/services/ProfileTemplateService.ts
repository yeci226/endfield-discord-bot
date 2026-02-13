import { ProfileTemplate } from "../interfaces/ProfileTemplate";
import { CustomDatabase } from "../utils/Database";
import crypto from "crypto";

export class ProfileTemplateService {
  private static DEFAULT_TEMPLATE: ProfileTemplate = {
    id: "default",
    name: "Default",
    authorId: "system",
    background: {
      url: "bg.08c7f0.png",
      overlay: "rgba(0, 0, 0, 0.4)",
    },
    canvas: {
      width: 2400,
      height: 1600,
      padding: 80,
    },
    elements: {
      // Avatar: padding (80), padding (80), size 180x180
      avatar: {
        x: 80,
        y: 80,
        width: 180,
        height: 180,
        radius: 30,
        visible: true,
      },
      // Name: padding + avatarSize + 40 = 300, padding + 90 = 170
      name: { x: 300, y: 170, fontSize: 80, bold: true, visible: true },
      // Badge: padding + avatarSize + 40 = 300, padding + 150 = 230
      badge: { x: 300, y: 225, fontSize: 36, visible: true },
      // Stats Grid: y = 320
      // itemWidth = (2400 - 160 - 90) / 4 = 537.5
      statsGrid: {
        x: 80,
        y: 320,
        itemWidth: 537.5,
        height: 140,
        gap: 30,
        visible: true,
      },
      // Mission Box: y = gridY + 160 = 480
      // width = (2400 - 160) * 0.7 - 10 = 1558
      missionBox: { x: 80, y: 480, width: 1558, height: 160, visible: true },
      // Auth Level Box: x = 80 + 1558 + 20 = 1658, y = 480
      // width = 2400 - 160 - 1558 - 20 = 662
      authLevelBox: { x: 1658, y: 480, width: 662, height: 160, visible: true },
      // Realtime Title: y = mlY + mlH + 30 = 480 + 160 + 30 = 670
      realtimeTitle: { x: 150, y: 670, fontSize: 50, visible: true },
      // Stamina Box: y = realTimeY + 80 = 670 + 80 = 750
      staminaBox: { x: 80, y: 750, width: 750, height: 180, visible: true },
      // Activity BP Box: x = 80 + 750 + 40 = 870, y = 750
      // width = 2400 - 160 - 750 - 40 = 1450
      activityBpBox: {
        x: 870,
        y: 750,
        width: 1450,
        height: 180,
        visible: true,
      },
      // Operators Title: y = realTimeY + sectionH + 140 = 670 + 180 + 140 = 990
      operatorsTitle: { x: 80, y: 990, fontSize: 50, visible: true },
      // Operators Grid: y = 1020 (charGridY)
      operatorsGrid: {
        x: 80,
        y: 1020,
        cols: 10,
        gap: 15,
        charWidth: 210,
        charHeight: 270,
        visible: true,
      },
    },
  };

  public static getDefaultTemplate(): ProfileTemplate {
    return JSON.parse(JSON.stringify(this.DEFAULT_TEMPLATE));
  }

  public static async getUserTemplate(
    db: CustomDatabase,
    userId: string,
  ): Promise<ProfileTemplate> {
    const userTemplate = await db.get(`profile.${userId}.template`);
    if (userTemplate) return userTemplate;
    return this.getDefaultTemplate();
  }

  public static async getTemplateById(
    db: CustomDatabase,
    id: string,
  ): Promise<ProfileTemplate | null> {
    if (id === "default") return this.getDefaultTemplate();
    return db.get(`profile.templates.${id}`);
  }

  public static async saveUserTemplate(
    db: CustomDatabase,
    userId: string,
    template: ProfileTemplate,
  ): Promise<void> {
    await db.set(`profile.${userId}.template`, template);
  }

  public static async toggleElement(
    db: CustomDatabase,
    userId: string,
    elementKey: keyof ProfileTemplate["elements"],
  ): Promise<boolean> {
    const template = await this.getUserTemplate(db, userId);
    if (template.elements[elementKey]) {
      template.elements[elementKey].visible =
        !template.elements[elementKey].visible;
      await this.saveUserTemplate(db, userId, template);
      return !!template.elements[elementKey].visible;
    }
    return false;
  }

  public static async updateBackground(
    db: CustomDatabase,
    userId: string,
    url: string,
  ): Promise<void> {
    const template = await this.getUserTemplate(db, userId);
    template.background.url = url;
    await this.saveUserTemplate(db, userId, template);
  }

  public static async shareTemplate(
    db: CustomDatabase,
    template: ProfileTemplate,
    authorId: string,
  ): Promise<string> {
    const id = crypto.randomBytes(4).toString("hex"); // 8 chars
    const newTemplate: ProfileTemplate = {
      ...template,
      id,
      authorId,
    };
    await db.set(`profile.templates.${id}`, newTemplate);
    return id;
  }
}
