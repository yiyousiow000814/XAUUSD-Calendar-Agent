---
name: xauusd-calendar-descriptions
description: Human-written economic calendar event descriptions for a global calendar with XAUUSD relevance and impact rules. Use when writing or reviewing event descriptions or notes for economic calendar entries, ensuring concise non-robotic language and conditional XAUUSD impact guidance.
---

# XAUUSD Economic Calendar Descriptions (Global, Human-Readable, No-Code)

## Goal

Generate concise, human-readable descriptions for economic calendar events in a global calendar, with optional impact notes only when relevant to XAUUSD.

## Scope

- Cover all countries and regions.
- Focus on XAUUSD.
- Produce 1-2 sentences per event.

## Output Rules

1. Use at most two sentences.
2. Sentence 1 (always): define what the event measures or decides using precise measurement terms:

   - rate, policy decision, index, diffusion index, weekly number, % change, balance, statement, minutes, auction
3. Sentence 2 (optional): add only if the event can plausibly influence XAUUSD via major pricing channels.

## Relevance Decision (When to add Sentence 2)

Add an impact sentence only if at least one condition is true:

### High relevance (usually add impact)

- Major central bank policy decisions or guidance from systemically important economies
  (rate decision, statement, minutes, press conference, key testimony or speech)
- Major inflation prints that can shift global rate expectations
  (headline or core CPI equivalents, PCE equivalents, PPI equivalents, especially for large economies)
- Major labor prints that move rate expectations or risk sentiment
  (jobs or payrolls, unemployment rate, wages; weekly claims where applicable)
- Major activity or risk indicators from large economies
  (PMI or ISM equivalents, GDP, retail sales, industrial production)

### Medium relevance (add impact only if widely watched or high-impact on the calendar)

- Secondary inflation, labor, or activity data from mid-sized economies
- Trade balance or current account when it is a market focus driver
- Long-dated government bond auctions (can affect yields or rates narrative)

### Low relevance (do not add impact)

- Small-country second-tier releases unlikely to move global USD, yields, or risk
- Niche sector indicators with limited market attention
- Local events with little spillover

Default behavior: if uncertain, omit Sentence 2 (definition-only is always acceptable).

## Impact Sentence Rules (If Sentence 2 is used)

Impact must be conditional and relative to expectations:

- Use: higher-than-expected / lower-than-expected (vs forecast)
- For central banks: hawkish or dovish surprise

Impact must explain through one primary channel (pick the most relevant, do not stack multiple):

1. USD and (real) yields or rate expectations
2. Risk sentiment or safe-haven demand
3. Inflation expectations feeding into yields

Keep it realistic: use can / may / often, not absolute will.

## Banned / Anti-Robotic Rules

- Never use: tracks
- Never call everything a growth indicator
- Never repeat the event name as its own definition
- Never prefix events with currency codes as if currency = country
- Avoid filler like important indicator or for the economy; say what it measures instead
- Avoid long, encyclopedic sentences and heavy parentheses

## No-Code / No-Batch-Generation Rule (Must Follow)

- Do not generate descriptions by code. Do not output any code, pseudocode, scripts, loops, batch logic, JSON batch structures, placeholders, or variable-style tokens (for example, anything like {Country} / {Period} / bracketed template fields).
- Each event description must read like it was individually written in natural language, even if there are thousands of events. Avoid uniform copy-paste sentence skeletons that clearly look programmatically stitched.
- Do not mention the generation method (no meta text like auto-generated, using a template, based on rules). Only output the final description text.

## Low-Relevance Handling (Optional)

If you must mention impact but relevance is low, use one restrained line only:

- Usually limited direct impact on XAUUSD unless it shifts broader USD, yields, or risk sentiment.

## Quality Gate (Self-check every event; rewrite if any fail)

Fail if:

- Banned phrases appear (tracks, growth indicator)
- More than 2 sentences
- Sentence 1 does not clearly define what it measures or decides
- Sentence 2 exists but lacks higher-than-expected / lower-than-expected (vs forecast) or hawkish/dovish framing
- Impact does not connect to USD, yields, risk, or safe-haven in a plausible way
- Text contains any placeholders or variables or looks like a batch template output

## Style Targets (Make it sound human)

- Use simple verbs: measures, sets, reflects, shows, provides
- Prefer concrete nouns: reading, index, policy rate, price pressures, weekly claims
- Keep the tone trader-readable: short, direct, no fluff

## Examples (Global calendar, XAUUSD-focused)

- Eurozone CPI (YoY) measures consumer inflation. Higher-than-expected inflation can raise yield expectations and pressure XAUUSD; softer inflation can support it.
- Bank of Japan Rate Decision sets the policy rate. A more hawkish-than-expected outcome can lift yields and weigh on XAUUSD; a dovish surprise can support it.
- China PMI is a diffusion index of business activity (50 = expansion). A weaker-than-expected reading can hurt risk sentiment and support XAUUSD as a safe haven.
- Norway Retail Sales (MoM) measures the monthly % change in consumer spending.
- US Fed Interest Rate Decision is the FOMC decision on the federal funds rate (target range). A more hawkish-than-expected outcome can lift USD and yields, often pressuring XAUUSD; a dovish surprise can support it.
- US Initial Jobless Claims is the weekly number of new unemployment benefit claims. Lower-than-expected claims can boost USD or yield expectations and weigh on XAUUSD; higher claims can support it.
- US Chicago PMI is a diffusion index of business conditions in the Chicago region (50 = expansion threshold). A higher-than-expected reading can lift USD and yields, often pressuring XAUUSD; a weaker reading can support it.
- ISM Manufacturing Prices Paid is a diffusion index of input price pressures in U.S. manufacturing. A higher-than-expected reading can raise inflation or yield expectations and pressure XAUUSD; a lower reading can support it.

## Core Execution Instruction (Use verbatim)

For each economic calendar event, write a short human-readable description for XAUUSD.
Use at most two sentences. The first sentence must define what the event measures or decides using precise measurement terms (rate/index/diffusion index/weekly number/% change/balance/statement/minutes/auction).
Only add a second sentence if the event is meaningfully relevant to XAUUSD (major central bank policy/guidance, major inflation, major labor, or major activity/risk indicators from widely watched economies, or anything that can shift global USD and yield expectations or risk sentiment).
If you add impact, it must be conditional and relative to expectations: use higher-than-expected / lower-than-expected (vs forecast) or hawkish/dovish surprise, and explain via USD, yields/real yields, rate expectations, or risk sentiment/safe-haven demand.
Never use tracks, never call everything a growth indicator, never repeat the event name as its own definition, and never prefix events with currency codes as if currency = country.
If relevance is low, write only the definition (or optionally one very restrained line saying direct impact is usually limited). After writing, self-check and rewrite if any rule is violated.
Do not output any code, placeholders, or batch-template text. Each description must read like it was individually written.