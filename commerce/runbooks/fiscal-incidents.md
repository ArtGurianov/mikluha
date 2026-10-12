# Fiscal incident handling — Alfa/OFD and historical Ferma evidence

This is diagnostic and incident-history documentation, **not** a new payment/fiscalization contract or permission to issue documents without a verified legal basis. Canonical checkout/payment terms remain in the merchant commerce configuration and accepted legal documents.

## Production Alfa/OFD diagnosis (ART-15)

When a buyer does not receive an emailed receipt, do not infer from the missing email that no fiscal document exists. In the Alfa cabinet inspect **Транзакции → Детали → История → ОФД Оплата** and corroborate the authoritative OFD/fiscal status. Where the intended Alfa/OFD integration reports no receipt, verify the fiscalization activation switch («Активировать систему») and provider configuration; a mismatched Ferma credential entered in Alfa's fiscalization configuration is a known cause. Treat credentials as secrets: never put them in tickets or logs. Resolve with the owner and provider, preserving redacted proof and avoiding duplicate receipts.

## Historical ₽1 canary correction (ART-246, ART-250)

The original 2026-10-01 ₽1 instantly delivered test service initially lacked its merchant-side fiscal document. It was resolved by a Ferma FFD 1.2 **correction-income receipt** delivered to the buyer, not a late ordinary sale receipt. The old MERCHANT/Ferma canary pathway was superseded for current production payment/refund receipts by the qualified Refref → Alfa/OFD PROVIDER path. The historical instantly delivered test service used FULL_PAYMENT. For a canary payment where the service **has not yet been rendered**, the appropriate correction-income receipt item must reflect **«Предоплата 100%» (FULL_PREPAYMENT)** rather than «Полный расчёт»; confirm the fiscal document type against the actual FFD/provider requirements before executing. Real future-trip prepayments likewise must not inherit the instantly delivered test-service fiscal semantics.

Mikluha's legal **АвтоУСН «Доходы»** may map to `USN_INCOME` / `taxSystem=1` in provider wire vocabulary. That is a technical mapping, not a statement that АвтоУСН and conventional УСН are the same legal regime. Confirm applicable tax settings with the owner and provider before changing a profile.

If a current sale lacks a required document, stop/contain affected sales, preserve timestamped transaction and fiscal evidence, obtain FFD/provider-specific remediation instructions and avoid automatic retroactive issuance. Never silently emit a second ordinary sale receipt. Manual final-settlement receipt obligations for rendered trips are tracked separately in ART-269.
