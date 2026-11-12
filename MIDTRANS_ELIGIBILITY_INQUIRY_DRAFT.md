# MIDTRANS ELIGIBILITY INQUIRY DRAFT

**Status: DRAFT — NOT SENT. No contact has been made with Midtrans. No application has been submitted. No merchant account exists. The product is planned only and is not yet launched.**

| Field | Value |
|---|---|
| Purpose | Obtain a written product-eligibility position from Midtrans for BOYFINITY Hub |
| Target recipient | Midtrans merchant onboarding / compliance |
| Prepared | 2026-11-11 |
| Revised | 2026-11-11 (owner-clarified intended use) |
| Submission state | **Not submitted. Awaiting owner approval of this draft.** |
| Product status | **Planned, not yet launched** |
| Related decision | D3 Payment provider — **UNAPPROVED** |
| Payment adapter | **BLOCKED** |

**Note on honesty:** this draft deliberately discloses that the scripts are designed to run through a Roblox executor. It does not disguise, soften, or omit that execution method. It makes no claim that the product is approved, compliant, or eligible, and it makes no claim that executor-based execution is automatically permitted. A refusal is a valid and useful outcome; it removes this candidate before any integration work is written.

**Note on attribution:** statements about script authorship, ownership, and distribution rights are **owner-declared facts**. This draft attributes them to the owner and does not present them as independently verified. Whether those declarations satisfy any Midtrans requirement is a question for Midtrans, asked in Section 6.

---

## 1. About the product

BOYFINITY Hub (the "Platform") is a **planned**, Indonesian-operated digital platform that provides **licensing, account management, and digital distribution of scripts** written for Roblox experiences. The Platform is a **web application**. It is not itself a game, and it does not operate, host, or publish a Roblox experience.

**Product status:** the Platform is **planned and not yet launched**. No sales have been made and no merchant account for it exists.

The following four roles must be kept distinct, because the eligibility question turns on their combination:

| Role | Who / what | Relationship to the Platform |
|---|---|---|
| **Licensing and distribution platform** | BOYFINITY Hub | The product that would be onboarded as a Midtrans merchant |
| **Scripts** | **Original scripts created by the product owner** | The Platform licenses and distributes them. The owner declares that they author these scripts and hold their distribution rights |
| **Roblox experiences** | **Roblox experiences owned by the product owner** | The intended use environment for the scripts, per the owner's declaration |
| **Executor software** | **Third-party software** | The method by which the scripts are run. It is **not** created, distributed, bundled, or licensed by the Platform or the owner |

**What we sell:** paid subscription access to a catalog of the owner's scripts, sold in **monthly, 3-month, and 6-month** periods, priced in **IDR**. There is also a free tier where a user can obtain a key by completing a third-party offer.

**What the Platform does:**
- Manages user accounts and sessions.
- Manages software keys, including issuance, activation, device binding, and revocation.
- Publishes a catalog of the owner's scripts and their versions.
- Manages subscription periods, expiry, and renewal.
- Processes payment for the paid subscription periods.

**What the Platform does not do:**
- It does not distribute Roblox itself.
- It does not provide or distribute a Roblox executor, injector, or exploit binary.
- It does not operate the environment in which the scripts execute.

## 2. Intended business model

| Element | Description |
|---|---|
| Revenue | Paid subscription access to the owner's script catalog, in IDR |
| Billing periods | Monthly, 3-month, 6-month |
| Renewal | **Manual per period.** Each renewal is a separate, user-initiated payment. There is **no automatic recurring charge** and no stored card credential |
| Free tier | A limited key is obtainable by completing a third-party offer (an advertiser-funded path) |
| Payout | Settlement to an Indonesian bank account |
| Currency | IDR only |
| Legal entity | The owner is exploring **individual merchant** registration. A registered business entity (PT/CV) is possible but is not currently held |

**Payment volume expectation:** this is a small digital business. Early volume is expected to be low — a small number of subscriptions per month, not high-volume throughput.

## 3. Proposed customer journey — not yet launched

**This workflow is proposed. It has not been launched, and no step below has been operated with real customers or real payments.**

1. **Discovery** — a prospective customer would visit the public site and view the script catalog and the available subscription plans.
2. **Account** — the customer would create an account on the Platform.
3. **Payment** — the customer would select a plan (monthly, 3-month, or 6-month) and pay in IDR, through a payment gateway checkout page.
4. **Entitlement** — once payment is confirmed, the Platform would grant the customer a subscription period and a **software key**.
5. **Distribution** — the customer would receive the key and download the script files from the Platform.
6. **Execution** — the customer would use the key to authenticate, and would run the downloaded script **through a Roblox executor** inside a Roblox experience. See Section 4.
7. **Expiry** — when the subscription period ends, the key would stop authenticating, and the customer could purchase another period.

**Important distinction:** what the Platform licenses and manages is **access, entitlement, and account/key state**. The Platform does not distribute the executor, and it does not control, operate, or supervise the execution environment on the customer's device. We nonetheless disclose the execution method below, because we understand it is material to your assessment.

## 4. Execution method — disclosed in full

**This is the disclosure we ask you to consider, and we are stating it plainly rather than obscuring it.**

The scripts distributed through the Platform are **designed to run through a Roblox executor** (also described as an injector or exploit tool). In ordinary use:

- The customer runs the script via a **third-party Roblox executor on their own device**.
- The script's intended environment is a **Roblox experience owned by the product owner**.
- The customer uses **their own Roblox account**.

**What we are not asking you to assess as the product:** we are not selling a Roblox executor. The executor is **third-party software**: it is **not** authored, distributed, bundled, sold, or licensed by the Platform or the owner, and it is **not** supplied by us as a prerequisite. The Platform licenses and manages **access to scripts and the associated account/key entitlement**.

**Ownership and distribution rights.** The owner declares that the scripts distributed through the Platform are **the owner's own original work**, that the owner **authorizes their own distribution**, and that the intended execution environment — the Roblox experiences — **is also owned by the owner**. This is an owner declaration, not an independently verified fact, and **it does not by itself establish compliance with Roblox policy or eligibility with Midtrans.** Whether the owner's authorship and ownership of the scripts and experiences changes Midtrans's assessment of executor-based execution is exactly what we are asking in Section 6.

**Why we are disclosing the executor association anyway:** it is material to the actual execution method of what we distribute, and we do not want an approval that rests on a description that leaves it out. We would rather receive a clear refusal based on the real execution method than an approval based on an incomplete one.

## 5. What we are asking Midtrans to confirm

We are asking for **written confirmation that specifically covers the product and business model described above** — not a general statement that merchant registration is possible.

We understand that a general merchant approval, a verbal indication from a sales or support contact, or silence on the product category would **not** answer our question. We need the product category and the execution method addressed explicitly.

## 6. Questions

**Eligibility of the model and the execution method**

1. **Is this exact business model permitted?** Specifically: a platform that sells paid subscription access to scripts authored by the merchant, for use in Roblox experiences owned by the merchant, where the scripts are executed through a third-party Roblox executor that the Platform does not distribute.
2. **Does executor-based script execution remain restricted even when the scripts and the Roblox experiences are owned by the merchant?** We are asking whether merchant ownership of the scripts and the experiences changes your treatment of executor-based execution at all, or whether the execution method is assessed independently of ownership.
3. **Is any additional evidence of ownership or authorization required?** If ownership matters to your assessment, what would you require us to document — for example, proof of authorship, proof of ownership of the Roblox experiences, or a written authorization — and in what form?
4. **Is this product category eligible for merchant onboarding at all?** If it is not, or if it is restricted, please state that in writing so that we can plan accordingly.

**Merchant registration, documents, fees, channels, and disputes**

5. **Can an individual merchant apply**, or is a registered business entity (PT/CV) required for this category?
6. **What legal and tax documents are required** (for example KTP, NPWP, and any category-specific documents)?
7. **What are the actual transaction fees for this category?** We are aware that your published pricing notes that "gaming and digital product companies are subject to different rates." We would like the applicable rate stated for this category.
8. **Which payment channels can be enabled** for this category and merchant type?
9. **What are the refund, chargeback, and dispute procedures** that would apply, including who bears the chargeback cost and what evidence is required?
10. **Can Midtrans provide written confirmation that explicitly covers the described product and business model?** If this product cannot be supported, we would also value a written statement to that effect, so that we can plan accordingly rather than proceed on an assumption.

## 7. What we are not claiming

To avoid any ambiguity:

- We are **not** claiming this product is approved, compliant, or eligible.
- We are **not** claiming that executor-based execution is automatically permitted.
- We are **not** claiming that owning the scripts or the Roblox experiences establishes Roblox policy compliance or Midtrans eligibility.
- We are **not** claiming that the absence of an explicit prohibition means it is permitted.
- We are **not** seeking an approval through an incomplete description.
- We are **not** asking for a channel-level workaround.

## 8. Accuracy declaration

The description in Sections 1 through 4 is an honest and complete account of the product and its execution method as currently planned. Nothing material to an eligibility assessment has been withheld. The executor-based execution method has been disclosed rather than omitted. Statements about script authorship, ownership, and distribution rights are the owner's declarations and are attributed as such. No approval, compliance, or eligibility is claimed anywhere in this document.

**Draft prepared for owner review. Not sent.**
