// Configured authentication follows listmonk internal/messenger/email/email.go and
// smtppool/v2 v2.2.1; exchanges use nodemailer 10.2.1's public customAuth API.
// The PLAIN transport guard follows Go 1.27.2 net/smtp/auth.go; its BSD notice
// is embedded in assets/licenses/go-1.27.2-BSD.txt.
import { createHmac } from "node:crypto";
import type SMTPConnection from "nodemailer/lib/smtp-connection";

export function requiredAuth(method: string, plainTransportAllowed: boolean) {
  return {
    forceAuth: true,
    authMethod: method,
    customAuth: {
      [method]: async (context: SMTPConnection.CustomAuthenticationContext) => {
        try {
          // Go smtp.PlainAuth.Start refuses non-localhost plaintext transport,
          // regardless of the advertised mechanism. TLS modes require a completed
          // TLS handshake in the transport before this callback is invoked.
          if (method === "PLAIN" && !plainTransportAllowed)
            throw new Error("Unencrypted authentication");
          // forceAuth prevents the pool skipping login; this guard prevents sending
          // credentials to a peer that did not advertise the configured mechanism.
          if (!context.authMethods.includes(method)) throw new Error("Unsupported authentication");
          const { user, pass } = context.auth.credentials;
          let response: SMTPConnection.CustomAuthenticationResponse;
          switch (method) {
            case "PLAIN": {
              const token = Buffer.from(`\0${user}\0${pass}`).toString("base64");
              response = await context.sendCommand(`AUTH PLAIN ${token}`);
              if (response.status === 334) response = await context.sendCommand(token);
              break;
            }
            case "LOGIN": {
              response = await context.sendCommand("AUTH LOGIN");
              while (response.status === 334) {
                const encoded = response.text.replace(/[\r\n]/g, "");
                if (
                  !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
                )
                  throw new Error("Invalid authentication challenge");
                const prompt = Buffer.from(encoded, "base64").toString("utf8");
                const credential =
                  prompt === "Username:" ? user : prompt === "Password:" ? pass : undefined;
                if (credential === undefined) throw new Error("Unknown authentication challenge");
                response = await context.sendCommand(Buffer.from(credential).toString("base64"));
              }
              break;
            }
            case "CRAM-MD5": {
              response = await context.sendCommand("AUTH CRAM-MD5");
              if (response.status !== 334) throw new Error("Authentication rejected");
              const challenge = Buffer.from(response.text, "base64");
              const digest = createHmac("md5", pass).update(challenge).digest("hex");
              response = await context.sendCommand(
                Buffer.from(`${user} ${digest}`).toString("base64"),
              );
              break;
            }
            default:
              throw new Error("Unsupported authentication");
          }
          if (response.status !== 235) throw new Error("Authentication rejected");
        } catch {
          // This handler runs before MAIL. Its failure proves this operation sent
          // no message; the marker comes from this owner, never a provider label.
          throw Object.assign(new Error("SMTP authentication failed"), {
            ownerAuthNotAccepted: true,
          });
        }
      },
    },
  };
}
