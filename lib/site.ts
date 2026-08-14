/** Build-time-only environment switch (PRD section 44) — no runtime env access, static export has no server. */
export const deployEnv = (process.env.DEPLOY_ENV === "staging" ? "staging" : "production") as
  | "production"
  | "staging";

export const isStaging = deployEnv === "staging";
