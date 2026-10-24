# Technical Due Diligence Checklist

## Purpose

Comprehensive question bank for evaluating a startup's technology, architecture, and technical team. Use selectively based on deal stage and technology depth.

---

## Architecture & Infrastructure

### System Architecture
- [ ] What is the high-level system architecture? (Monolith, microservices, serverless, hybrid?)
- [ ] What languages and frameworks are used? Are they appropriate for the problem?
- [ ] What cloud infrastructure is used? (AWS, GCP (Google Cloud Platform), Azure, multi-cloud?)
- [ ] Is the architecture documented? Can someone new understand it within a week?
- [ ] What are the known architectural limitations? What breaks at 10x scale?

### Scalability
- [ ] What's the current load? (QPS (Queries Per Second), concurrent users, data volume)
- [ ] What's the maximum load before degradation? Have they tested this?
- [ ] What would need to change to handle 10x current load? 100x?
- [ ] Are there single points of failure? What happens when they go down?
- [ ] Is horizontal scaling possible, or does scaling require re-architecture?

### Security
- [ ] What security practices are in place? (Authentication, encryption, access controls)
- [ ] Has a security audit been conducted? By whom? When?
- [ ] How is sensitive data (PII (Personally Identifiable Information), financial, health) stored and transmitted?
- [ ] Is there an incident response plan?
- [ ] SOC 2 compliance status? Other relevant certifications?

### Data Architecture
- [ ] What databases are used? Are they appropriate for the data model?
- [ ] How is data backed up? What's the recovery time objective (RTO)?
- [ ] Is there a data pipeline for analytics? How is it architected?
- [ ] Data retention and deletion policies — compliant with regulations?
- [ ] What's the data migration strategy if a customer wants to leave?

---

## Code Quality & Practices

### Development Process
- [ ] What version control system is used? (Git is expected)
- [ ] Is there a code review process? What percentage of code is reviewed?
- [ ] What's the CI/CD (Continuous Integration / Continuous Deployment) pipeline? Automated testing? Automated deployment?
- [ ] What's the deployment frequency? (Daily = strong signal, monthly = concerning)
- [ ] How long does it take to deploy a fix for a critical bug?

### Testing
- [ ] What testing frameworks are used? Unit, integration, end-to-end?
- [ ] What's the test coverage? (>70% = good, <30% = concerning)
- [ ] Are tests run automatically on every commit?
- [ ] Load testing — has it been done? What were the results?
- [ ] How are regressions caught?

### Technical Debt
- [ ] Is technical debt tracked? How is it prioritized against features?
- [ ] What are the biggest known areas of technical debt?
- [ ] How much engineering time is spent on maintenance vs. new features? (>50% maintenance at early stage = red flag)
- [ ] Are there areas of the codebase that no one wants to touch? Why?

---

## Product & Technology

### Core Technology Assessment
- [ ] What is the core technology innovation? Is it genuinely novel or well-executed existing tech?
- [ ] Can you explain the technology to a non-technical person? (If the founders can't, it may not be clearly defined)
- [ ] Has the core technology been validated? By whom? (Peer review, customer usage, independent assessment?)
- [ ] What are the core technology risks? What could make it not work?
- [ ] What's the technology roadmap for the next 12-24 months?

### AI/ML (if applicable)
- [ ] What models are used? Custom-trained, fine-tuned, or API-based (GPT, Claude, etc.)?
- [ ] What's the training data source? Is it proprietary, licensed, or public?
- [ ] Model performance metrics — accuracy, latency, cost per inference?
- [ ] How does the model improve over time? Is there a data flywheel?
- [ ] What happens if the underlying model provider (OpenAI, Anthropic) changes pricing or terms?
- [ ] Is the AI core to the product or a wrapper? (The "thin wrapper" test)

### Integration & Interoperability
- [ ] What integrations exist? (CRM, ERP, payment, communication, data sources?)
- [ ] How are integrations built? (Native, API-based, iPaaS (Integration Platform as a Service)?)
- [ ] What's the cost and timeline for building new integrations?
- [ ] How dependent is the product on third-party APIs? What happens if they change or deprecate?

---

## Technical Team

### Team Composition
- [ ] How many engineers? Frontend, backend, full-stack, ML, DevOps, QA breakdown?
- [ ] What's the ratio of engineers to total company? (>50% at early-stage = healthy)
- [ ] Where are engineers located? In-house, remote, contracted, offshore?
- [ ] What's the engineering retention rate? (High turnover = warning signal)

### Technical Leadership
- [ ] CTO/VP Engineering background — have they built and scaled similar systems?
- [ ] Is there a clear technical vision and architecture roadmap?
- [ ] How are technical decisions made? Collaborative or single-authority?
- [ ] Can the technical lead recruit senior engineers? (Check their network and hiring track record)

### Hiring & Growth
- [ ] What engineering roles need to be hired in the next 12 months?
- [ ] How competitive is hiring for these roles? Can they compete on compensation?
- [ ] Is there a technical interview process that filters for quality?
- [ ] What's the onboarding time for new engineers? (<4 weeks = well-organized)

---

## Intellectual Property

### IP Ownership
- [ ] Are all IP assignment agreements signed? (Founders, employees, contractors)
- [ ] Is any core IP licensed from a university or prior employer?
- [ ] Are there any claims or disputes over IP ownership?
- [ ] Has a Freedom to Operate (FTO) search been conducted?

### Patents
- [ ] How many patents filed? Granted? Pending?
- [ ] What jurisdictions are patents filed in?
- [ ] Are patent claims broad enough to provide meaningful protection?
- [ ] Who holds the patents? (Must be the company, not individuals)

### Open Source
- [ ] What open-source components are used? Are licenses tracked?
- [ ] Are any copyleft licenses (GPL (General Public License), AGPL (Affero General Public License)) in use that could require the product to be open-sourced?
- [ ] Does the company contribute to open source? (Positive for recruiting)
- [ ] Is there a clear policy on open-source usage and contribution?

---

## Technology Risk Summary

| Risk Area | Level (Low/Med/High) | Mitigation |
|---|---|---|
| Science risk | | |
| Engineering risk | | |
| Scale risk | | |
| Platform dependency | | |
| Security risk | | |
| IP risk | | |
| Talent risk | | |
| Technical debt | | |
