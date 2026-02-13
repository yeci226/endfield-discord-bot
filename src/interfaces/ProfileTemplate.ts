export interface ProfileElement {
  x: number;
  y: number;
  width?: number;
  height?: number;
  fontSize?: number;
  color?: string;
  visible?: boolean;
  angle?: number;
  shadowOffset?: number;
  shadowBlur?: number;
  stroke?: string;
  strokeWidth?: number;
}

export interface ProfileTemplate {
  id: string; // UUID or short code
  name: string;
  authorId?: string;
  background: {
    url: string; // "bg.08c7f0.png" or "https://..."
    overlay?: string; // "rgba(0,0,0,0.4)"
    x?: number;
    y?: number;
    scale?: number;
    fillType?: "none" | "color" | "blur";
    fillColor?: string;
  };
  canvas: {
    width: number;
    height: number;
    padding: number;
  };
  elements: {
    avatar: ProfileElement & { radius?: number };
    name: ProfileElement & { bold?: boolean };
    badge: ProfileElement; // AwakeDate, LastLogin, UID info row
    statsGrid: ProfileElement & { itemWidth: number; gap: number };
    missionBox: ProfileElement;
    authLevelBox: ProfileElement;
    realtimeTitle: ProfileElement;
    staminaBox: ProfileElement;
    activityBpBox: ProfileElement;
    operatorsTitle: ProfileElement;
    operatorsGrid: ProfileElement & {
      cols: number;
      gap: number;
      charWidth: number;
      charHeight: number;
      limit?: number;
    };
  };
  fabricJson?: any;
}
