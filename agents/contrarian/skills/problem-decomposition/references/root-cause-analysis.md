# Root Cause Analysis: Fishbone and 5 Whys

## Overview

Root Cause Analysis (RCA) is a systematic method for identifying the underlying causes of problems, not just symptoms. Two complementary approaches dominate: Ishikawa (Fishbone) Diagrams for structured brainstorming, and the 5 Whys technique for iterative drilling. Combine them to build comprehensive causal maps suitable for operational incidents, failures, and systemic issues.

## When to Use RCA

- After an incident or failure has occurred and you need to prevent recurrence
- When a symptom (e.g., slow server response) masks the actual problem (e.g., database connection leak)
- To move beyond "blame" or "quick fixes" to durable solutions
- In Complicated domain problems (Cynefin) where causes can be analyzed systematically
- When organizational learning and improvement are priorities

## The Fishbone (Ishikawa) Diagram

### Core Structure

The Fishbone Diagram organizes potential causes into six categories (the 6Ms):

1. **Materials** — Inputs, supplies, components, data quality
2. **Methods** — Processes, procedures, workflows, decision logic
3. **Machines** — Equipment, tools, infrastructure, systems
4. **Manpower** — Personnel, skills, training, staffing levels, communication
5. **Measurement** — Metrics, monitoring, visibility, alerting
6. **Environment** — Context, external factors, dependencies, third parties

(Some frameworks add a seventh: **Management** or **Milieu**)

### How to Build a Fishbone Diagram

1. **Define the problem** (head of the fish): Be specific, not vague.
   - Bad: "System is slow"
   - Good: "API response time exceeded 5 seconds for 30% of requests on 2026-03-22 19:00–20:30"

2. **Draw the main spine** and label it with the problem.

3. **Draw six major branches** (the 6Ms) extending from the spine.

4. **Brainstorm sub-causes** for each category. Add secondary and tertiary branches as needed.
   - Materials → Database connection pool exhausted, stale cache entries
   - Methods → Query optimization not applied, no request queuing logic
   - Machines → Insufficient CPU allocation, network latency spike
   - Manpower → On-call engineer unfamiliar with new code, no runbook
   - Measurement → No P99 latency alerts, spotty logging
   - Environment → Third-party API slowdown, unexpected traffic surge

5. **Identify the most likely primary causes** (thick branches with multiple sub-causes or those supported by evidence).

### Strength of Fishbone Diagrams

- Forces systematic consideration of multiple cause categories, reducing blind spots
- Facilitates team discussion and knowledge sharing
- Visual, easy to update as new information emerges
- No need for deep causal chains; breadth is the goal

### Limitations

- Does not prioritize causes by likelihood or impact
- Does not drill deep into why each cause occurred
- Can become unwieldy with too many sub-causes
- Requires facilitation to avoid groupthink

## The 5 Whys Technique

### Core Principle

Ask "Why?" in response to each answer until you reach a root cause that you can act upon. Typically 3–5 iterations are needed.

### Step-by-Step Procedure

1. **State the problem.** "The production server became unresponsive."

2. **Ask Why #1.** "Why did it become unresponsive?"
   - Answer: "The application was consuming 100% CPU."

3. **Ask Why #2.** "Why was it consuming 100% CPU?"
   - Answer: "A query in the notification service was running in a tight loop."

4. **Ask Why #3.** "Why was the query running in a tight loop?"
   - Answer: "The query had no LIMIT clause; it returned 2 million rows and tried to process all in memory."

5. **Ask Why #4.** "Why did no one catch this before production?"
   - Answer: "The staging environment has a much smaller dataset (10k rows), so the query completed quickly."

6. **Ask Why #5.** "Why does staging have a different dataset than production?"
   - Answer: "There is no standard process for syncing production-representative data to staging."

**Root Cause(s):** Multiple layers:
- Immediate: Missing LIMIT clause in query
- Systemic: No code review for resource efficiency, no staging–production parity, insufficient testing with production-scale data

### When to Stop

Stop asking "Why?" when you reach a cause that:
- Is actionable (you can do something about it)
- Requires a decision or policy change to address
- Is not just shifting blame to another person or team

## Combining Fishbone and 5 Whys

Use them together for maximum insight:

**Phase 1: Breadth (Fishbone)**
- Brainstorm all plausible causes across the 6Ms
- Identify 2–3 most likely primary causes
- Avoid premature dismissal; keep options open

**Phase 2: Depth (5 Whys)**
- For each primary cause identified in Phase 1, apply 5 Whys
- Drill until you hit systemic or process issues (not personalities)
- Document the "Why chain" for each cause

**Phase 3: Synthesis**
- Identify which causes are most frequent across different failures
- Prioritize by impact (severity × likelihood)
- Design preventive measures that address systemic causes

## Worked Example: Production Incident — Payment Processing Failure

### The Incident
"Payment processing failed for 15 minutes on 2026-03-22 at 14:00 UTC. 847 transactions were affected. Root cause unknown."

### Phase 1: Fishbone Diagram

```
Production: Payment Processing Failed
├─ Materials
│  ├─ Database connection pool saturated
│  └─ No rollover buffer for payment queues
├─ Methods
│  ├─ No circuit breaker pattern for external payment API
│  ├─ Retry logic without backoff
│  └─ Transactions not idempotent
├─ Machines
│  ├─ Load balancer misconfigured (uneven distribution)
│  ├─ Payment API server hit by DDoS (external)
│  └─ Network latency spike
├─ Manpower
│  ├─ On-call engineer not trained on payment reconciliation
│  └─ Communication gap between payments and infrastructure teams
├─ Measurement
│  ├─ No separate alerting for payment latency
│  ├─ Logs did not show payment API response times
│  └─ No real-time transaction monitoring
└─ Environment
   ├─ Payment processor overloaded (external factor)
   ├─ New traffic surge from promotion campaign
   └─ Dependency on third-party payment API
```

### Phase 2: 5 Whys for Top Cause: Load Balancer Misconfiguration

1. **Why did transactions fail?**
   - Answer: Requests backed up; database connections timed out.

2. **Why did requests back up?**
   - Answer: The load balancer was sending 70% of requests to one server and 30% to another.

3. **Why was the load balancer misconfigured?**
   - Answer: A recent deployment changed the server pool without updating the weights.

4. **Why was this not caught before production?**
   - Answer: No automated tests verify load balancer configuration matches deployment manifest.

5. **Why don't we have such tests?**
   - Answer: Infrastructure configuration was not treated as "code" requiring test coverage; it was treated as manual documentation.

**Actionable Root Causes:**
- Immediate: Rebalance load balancer weights (hotfix)
- Systemic: Add automated validation of load balancer config, treat infrastructure as code, add pre-deployment checks

### Phase 2b: 5 Whys for Secondary Cause: No Circuit Breaker

1. **Why did retries compound the problem?**
   - Answer: Requests were retried immediately with no backoff, flooding the payment processor.

2. **Why was there no circuit breaker?**
   - Answer: Payment API was assumed to be 100% reliable; resilience patterns were not implemented.

3. **Why was it assumed to be reliable?**
   - Answer: The service level agreement (SLA) commitment was theoretical; operational reality was not tested.

4. **Why was it not tested?**
   - Answer: Chaos engineering and fault injection are not part of the testing strategy.

5. **Why aren't they part of the strategy?**
   - Answer: Team was not aware of the practice; no training or tooling budget allocated.

**Actionable Root Causes:**
- Immediate: Implement circuit breaker with exponential backoff
- Systemic: Adopt chaos engineering practice, conduct quarterly failure mode analysis (FMEA)

### Phase 3: Prevention Plan

| Root Cause | Prevention Measure | Owner | Timeline |
|------------|-------------------|-------|----------|
| Load balancer config skew | Infrastructure-as-Code framework + automated validation | DevOps | 2 weeks |
| No circuit breaker | Implement Resilience4j/Polly library in payments service | Backend lead | 1 week |
| No separate latency alerting | Add payment API latency P95/P99 alerts to PagerDuty | SRE | 3 days |
| No production-scale testing | Monthly chaos engineering game day | QA lead | Ongoing |
| No payment reconciliation runbook | Create runbook + conduct training with on-call team | Payments PM | 1 week |

## Tips for AI Agents

1. **Start with the symptom, not the explanation.** "The server is slow" → Ask why systematically. Don't assume you know the cause.
2. **Use Fishbone for breadth first.** It prevents the anchoring bias of jumping to the first plausible cause.
3. **Apply 5 Whys to the most likely causes from Fishbone.** Not every branch needs 5 Whys; focus on high-probability ones.
4. **Look for systemic causes, not blame.** The goal is to fix systems, not individuals.
5. **Document the entire chain.** Stakeholders need to see the reasoning, not just the final answer.
6. **Distinguish immediate fixes from permanent solutions.** Immediate fixes (hotfixes) stop the pain; systemic solutions prevent recurrence.

## Common Pitfalls

| Pitfall | What Happens | How to Avoid |
|---------|--------------|-------------|
| **Stopping too early** | "The query was slow" → Done. (Never addresses why it lacked a LIMIT.) | Push through at least 3–4 Whys; stop only when you reach process/policy level. |
| **Blaming people, not processes** | "The engineer didn't test properly." | Reframe: "Why didn't the testing process catch this?" Blame systems, not individuals. |
| **Over-generalizing** | "The problem is lack of monitoring." (But actually, it was lack of staging–production parity.) | Ensure each Why has evidence. Avoid vague systemic answers; drill until specific. |
| **Confusing correlation with causation** | "Traffic spiked, then payment failed. Traffic caused it." (Actually, misconfigured LB amplified the load.) | Ask "Would this failure have occurred without the traffic spike?" to separate trigger from root cause. |
| **Ignoring external factors** | All causes assigned to internal teams. (But payment processor was DDoSed.) | Fishbone's "Environment" category prevents this; always include external dependencies. |

## References

- Ishikawa, K. (1968). *Guide to Quality Control*. Japanese Union of Scientists and Engineers.
- Toyota Production System (TPS) and 5S: Foundation for RCA in lean manufacturing.
- Dooley, K. J. (1997). "A Complex Adaptive Systems Model of Organizational Change." *Nonlinear Dynamics, Psychology, and Life Sciences*.
