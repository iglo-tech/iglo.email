export type Mode = "reference" | "normal";
export type TargetName = "upstream" | "production" | "fixture";
export type Profile = "all" | "core" | "staged" | "probe";
export type Group = "core" | "staged" | "reference-only" | "production-only" | "probe";
export type Difference = "D17" | "D18" | "D21";

export interface Credentials {
  readonly user: string;
  readonly token: string;
}

export interface VolatileField {
  readonly path: readonly string[];
  readonly kind: "id" | "timestamp";
  readonly bind: string;
  readonly after?: string;
  readonly requireBound?: boolean;
}

export type ExpectedBody =
  | { readonly kind: "wire"; readonly value: string }
  | { readonly kind: "json"; readonly value: unknown; readonly volatile: readonly VolatileField[] }
  | {
      readonly kind: "public-404";
      readonly siteName: string;
      readonly attribution: string;
      readonly attributionUrl: string;
      readonly customScript: boolean;
      readonly archiveTitle: string | null;
    }
  | { readonly kind: "public-css" };

export interface Expectation {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: ExpectedBody;
  readonly headers?: Readonly<Record<string, string | null>>;
}

export interface Endpoint {
  readonly path: string;
  readonly expect: Expectation;
}

export interface ContractCase {
  readonly id: string;
  readonly group: Group;
  readonly reference?: Endpoint;
  readonly production?: Endpoint;
  readonly fixture?: Endpoint;
  readonly method?: "GET" | "POST" | "HEAD" | "OPTIONS";
  readonly requestBody?: string;
  readonly requestContentType?: string;
  readonly auth?: "basic" | "token" | "bad-token";
  readonly difference?: Difference;
}

export interface ContractTarget {
  readonly mode: Mode;
  readonly target: TargetName;
  readonly profile: Profile;
  readonly baseUrl: string;
  readonly credentials?: Credentials;
  readonly signal?: AbortSignal;
}
