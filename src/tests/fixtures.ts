// Public descriptor key and origin published in Bitcoin Core's descriptor documentation:
// https://github.com/bitcoin/bitcoin/blob/master/doc/descriptors.md
// [6f53d49c/44h/1h/0h]tpubDDjsCRDQ9YzyaAq9rspCfq8RZFrWoBpYnLxK6sS2hS2yukqSczgcYiur8Scx4Hd5AZatxTuzMtJQJhchufv1FRFanLqUP7JHwusSSpfcEp2
export const validTestTpub = "tpubDDjsCRDQ9YzyaAq9rspCfq8RZFrWoBpYnLxK6sS2hS2yukqSczgcYiur8Scx4Hd5AZatxTuzMtJQJhchufv1FRFanLqUP7JHwusSSpfcEp2";

export const validTestTpubOrigin = {
  masterFingerprint: "6f53d49c",
  sourcePath: "m/44'/1'/0'",
} as const;
