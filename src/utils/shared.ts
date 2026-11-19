const EPHEMERAL_FLAG = 64;

export class TtlCache<K, V> {
  private ttlMs: number;
  private maxSize: number;
  private store: Map<K, { value: V; expiresAt: number }>;
  private inFlight: Map<K, Promise<V | undefined>>;

  constructor(ttlMs = 60_000, maxSize = 5_000) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
    this.store = new Map();
    this.inFlight = new Map();
  }

  get(key: K): V | undefined {
    const item = this.store.get(key);
    if (!item) return undefined;

    if (item.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }

    return item.value;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  set(key: K, value: V): void {
    if (this.store.size >= this.maxSize) {
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) {
        this.store.delete(firstKey);
      }
    }

    this.store.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  delete(key: K): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
    this.inFlight.clear();
  }

  async getOrSetAsync(
    key: K,
    loader: () => Promise<V | undefined>,
  ): Promise<V | undefined> {
    const cached = this.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }

    const pending = (async () => {
      try {
        const value = await loader();
        if (value !== undefined) {
          this.set(key, value);
        }
        return value;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, pending);
    return pending;
  }
}

export function fireAndForget(
  promise: Promise<unknown>,
  logger?: { error: (msg: string) => void },
): void {
  if (!promise || typeof (promise as any).then !== "function") return;

  promise.catch((error: any) => {
    if (logger && typeof logger.error === "function") {
      logger.error(error?.message || String(error));
      return;
    }
    console.error(error);
  });
}

interface CommandLike {
  usesModal?: boolean;
  showModal?: boolean;
  opensModal?: boolean;
  autoDefer?: boolean;
  defer?: boolean;
  ephemeral?: boolean;
  defaultEphemeral?: boolean;
  autoDeferEphemeral?: boolean;
  meta?: {
    usesModal?: boolean;
    autoDefer?: boolean;
    ephemeral?: boolean;
    defaultEphemeral?: boolean;
  };
}

export function getCommandAckPlan(
  command: unknown,
  options: { defaultEphemeral?: boolean } = {},
): { shouldDefer: boolean; ephemeral: boolean; usesModal: boolean } {
  const cmd = command as CommandLike | undefined;
  const defaultEphemeral = options.defaultEphemeral ?? true;
  const meta = cmd?.meta ?? {};

  const usesModal =
    cmd?.usesModal === true ||
    cmd?.showModal === true ||
    cmd?.opensModal === true ||
    meta.usesModal === true;

  const autoDefer =
    cmd?.autoDefer === true ||
    cmd?.defer === true ||
    meta.autoDefer === true;

  const ephemeral =
    cmd?.ephemeral ??
    cmd?.defaultEphemeral ??
    cmd?.autoDeferEphemeral ??
    meta.ephemeral ??
    meta.defaultEphemeral ??
    defaultEphemeral;

  return {
    shouldDefer: autoDefer && !usesModal,
    ephemeral: Boolean(ephemeral),
    usesModal,
  };
}

export async function ensureDeferredReply(
  interaction: {
    deferred?: boolean;
    replied?: boolean;
    deferReply: (options?: object) => Promise<unknown>;
  },
  ephemeral = true,
): Promise<boolean> {
  if (!interaction || interaction.deferred || interaction.replied) {
    return false;
  }

  const options = ephemeral ? { flags: EPHEMERAL_FLAG } : {};
  await interaction.deferReply(options);
  return true;
}

export async function replyOrFollowUp(
  interaction: {
    deferred?: boolean;
    replied?: boolean;
    reply: (payload: object) => Promise<unknown>;
    followUp: (payload: object) => Promise<unknown>;
  } | null,
  payload: object,
): Promise<unknown> {
  if (!interaction) return null;

  if (interaction.deferred || interaction.replied) {
    return interaction.followUp(payload);
  }

  return interaction.reply(payload);
}

/** Discord codes meaning the interaction can no longer be answered. */
const DEAD_INTERACTION_CODES = new Set([10062, 40060]);

export function isDeadInteractionError(error: unknown): boolean {
  return DEAD_INTERACTION_CODES.has(Number((error as any)?.code));
}

export type InteractionErrorPlan =
  | "respondEmpty"
  | "reply"
  | "followUp";

/**
 * How to tell the user something went wrong, given what has already been sent.
 * Autocomplete can only answer with a (possibly empty) choice list; everything
 * else gets an ephemeral message. After a defer or reply, followUp is the one
 * call that works for both deferReply (fills the pending reply) and
 * deferUpdate (leaves the original message and its buttons untouched).
 */
export function planInteractionError(state: {
  isAutocomplete: boolean;
  deferred: boolean;
  replied: boolean;
}): InteractionErrorPlan {
  if (state.isAutocomplete) return "respondEmpty";
  return state.deferred || state.replied ? "followUp" : "reply";
}

/** Best effort: never throws. Returns true when something was sent. */
export async function sendInteractionError(
  interaction: any,
  content: string,
): Promise<boolean> {
  try {
    const plan = planInteractionError({
      isAutocomplete:
        typeof interaction.isAutocomplete === "function" &&
        interaction.isAutocomplete(),
      deferred: !!interaction.deferred,
      replied: !!interaction.replied,
    });
    if (plan === "respondEmpty") {
      if (interaction.responded) return false;
      await interaction.respond([]);
    } else if (plan === "followUp") {
      await interaction.followUp({ content, flags: EPHEMERAL_FLAG });
    } else {
      await interaction.reply({ content, flags: EPHEMERAL_FLAG });
    }
    return true;
  } catch {
    return false;
  }
}
