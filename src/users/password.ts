// The password rules of every path that sets one, adapted from listmonk cmd/users.go at 6fcd95f.
import { strHasLen } from "@/server/validation";

export const validPassword = (password: string): boolean => strHasLen(password, 8, 2000);

export const hashPassword = (password: string): Promise<string> =>
  Bun.password.hash(password, { algorithm: "argon2id" });
