export type TierHolder = { host: string; boot: number; mount: string };
export type TierFence = { holder: TierHolder; epoch: number };
export type TierClaims = {
  sub: string;
  lin?: string;
  acc: "r" | "w";
  refs?: string[];
  fence?: TierFence;
};
