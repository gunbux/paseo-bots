import { isAbsolute } from "node:path";
import { z } from "zod";

const id = z.string().regex(/^[1-9]\d*$/);
const schema = z.object({
  enabled: z.literal(true),
  botId: z.string().regex(/^[a-z0-9-]+$/),
  allowedUserIds: z.array(id).min(1),
  allowedChatIds: z.array(id).min(1),
  tokenFile: z.string().refine(isAbsolute, "tokenFile must be absolute"),
  bootstrapCommand: z.tuple([z.string().refine(isAbsolute)]).rest(z.string()).optional(),
});
export type TelegramConfig = z.infer<typeof schema>;
export function parseTelegramConfig(value: unknown): TelegramConfig | null {
  if (z.object({ enabled: z.literal(false) }).safeParse(value).success) return null;
  return schema.parse(value);
}
