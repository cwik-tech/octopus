# Domain Scanning Methods: Deep Reference

This document provides the comprehensive reference material for the Application Domain Scanner skill. Use these sections when conducting domain scans at Step 1 (NAICS/ISIC Taxonomy Traversal), Step 2 (Jobs-to-be-Done Analysis), Step 3 (Analogical Reasoning), and Step 4 (Constraint-Relief Mapping).

---

## NAICS Sector Taxonomy: All 20 Top-Level Divisions

### 11 — Agriculture, Forestry, Fishing, Hunting

**Code range:** 111–115

**Core definition:** Production of crops, livestock, forest products, and wild-capture resources. Includes farming, ranching, timber harvesting, fishing, hunting, and support services.

**Core activities:**
- Crop cultivation (vegetables, grains, specialty crops, organics)
- Livestock production (cattle, poultry, dairy, aquaculture)
- Forest management and timber harvesting
- Commercial fishing and wild-capture operations
- Agricultural support services (equipment hire, crop dusting, veterinary services)

**Commonly overlooked applications:**
- Precision agriculture and soil monitoring (data-intensive constraint-relief opportunities)
- Supply chain coordination in perishables (timing and logistics challenges)
- Regulatory compliance in pesticide/antibiotic documentation
- Herd/flock health tracking at scale (emerging JTBD in pandemic-aware farming)

**Hidden opportunity patterns:**
- High seasonality creates coordination bottlenecks (contrast with steady-state manufacturing)
- Commodity price volatility creates planning uncertainty not present in other sectors
- Environmental regulatory tightening (nitrogen runoff, water use, greenhouse gas reporting) creates compliance JTBD
- Labor scarcity in developed economies drives automation and remote monitoring demand

---

### 21 — Mining, Quarrying, Oil & Gas Extraction

**Code range:** 211–213

**Core definition:** Extraction of mineral resources, crude oil, natural gas, and other natural deposits from the earth. Includes exploration, extraction, beneficiation (initial processing), and support services.

**Core activities:**
- Oil and natural gas drilling and production
- Coal, metal ore (iron, copper, gold), and nonmetallic mineral mining
- Quarrying (stone, sand, gravel)
- Mineral beneficiation (crushing, sorting, flotation)
- Exploration and geological surveying
- Extraction support services (drilling contractors, geophysical services)

**Commonly overlooked applications:**
- Deep-sea and frontier resource location (extreme data-scarcity problem)
- Tailings management and environmental remediation (massive scale constraint)
- Remote site coordination (camps, workers across difficult geography)
- Commodity trading and hedging (price volatility management)

**Hidden opportunity patterns:**
- Extreme capital intensity creates long development cycles (decades from discovery to production)
- High-risk exploration: massive spend on exploration with low hit rates (decision-making under uncertainty JTBD)
- Cyclical demand and oversupply create "zombie projects" that are too expensive to maintain but too valuable to abandon
- Geopolitical concentration (critical minerals from few countries) creates supply-chain instability JTBD

---

### 22 — Utilities

**Code range:** 221–222

**Core definition:** Generation, transmission, and distribution of electricity, natural gas, water, and wastewater services to end consumers. Heavily regulated monopolies or regulated oligopolies.

**Core activities:**
- Electric power generation (coal, gas, hydro, nuclear, renewable)
- Electric transmission and distribution
- Natural gas production, transmission, distribution
- Water and wastewater treatment and distribution
- Support services (meter reading, line maintenance, emergency response)

**Commonly overlooked applications:**
- Grid load balancing in real-time (managing supply-demand mismatch across seconds)
- Distributed renewable integration (variable solar/wind creating coordination complexity)
- Aging infrastructure replacement (many systems 40-50+ years old)
- Demand forecasting at substation level (local consumption prediction)
- Leak detection in water systems (unaccounted-for water, revenue loss)

**Hidden opportunity patterns:**
- Regulated rate structures create weak incentives for cost reduction (cost-plus regulation passes through expenses)
- Infrastructure was built for one-way power flow; distributed generation (rooftop solar) requires rearchitecture
- Intermittency of renewables creates new storage and balancing JTBD not present in fossil-fuel era
- Extreme reliability requirements (99.999%+ uptime) create JTBD around redundancy and failure prediction

---

### 23 — Construction

**Code range:** 236–238

**Core definition:** Assembly of buildings, infrastructure, and structures. Includes site preparation, foundation, structural, and finishing work. Excludes design (92) but includes project management on-site.

**Core activities:**
- Residential building construction (single-family, multi-family)
- Commercial and industrial building construction
- Heavy and civil engineering construction (bridges, highways, dams, railways, pipelines)
- Specialty trade contracting (electrical, plumbing, HVAC, roofing, painting)
- Site preparation and demolition

**Commonly overlooked applications:**
- Workforce scheduling across job sites (high fragmentation, seasonal demand)
- Materials procurement and logistics (just-in-time delivery to sites, waste reduction)
- Safety compliance and incident tracking (high-consequence environment)
- Weather-dependent work sequencing and replanning
- Subcontractor coordination and payment processing

**Hidden opportunity patterns:**
- Project-based work (discrete chunks) creates different planning and coordination JTBD than continuous production
- High regulatory fragmentation (building codes vary by jurisdiction, creating compliance overhead)
- Information flow between design (architect/engineer) and execution (contractor) remains largely paper-based or fragmented
- Rework and defect discovery late in projects create expensive cascading delays
- Skills shortage in trades creates training and knowledge-transfer JTBD

---

### 31-33 — Manufacturing

**Code range:** 311–337

**Core definition:** Transformation of raw materials and components into finished goods using machinery and human labor. Includes food, chemical, machinery, automotive, electronics, textiles, and hundreds of subsectors.

**Core activities (major subsectors):**
- Food and beverage manufacturing (processing, packaging, preservation)
- Textile, apparel, leather product manufacturing
- Wood product manufacturing
- Paper and pulp manufacturing
- Chemical and pharmaceutical manufacturing
- Plastics and rubber product manufacturing
- Nonmetallic mineral product manufacturing (glass, cement, ceramics)
- Primary metal manufacturing (steel mills, smelting, refining)
- Fabricated metal product manufacturing
- Machinery manufacturing (industrial equipment, engines, turbines)
- Computer and electronic product manufacturing (semiconductors, circuit boards, devices)
- Electrical equipment and appliance manufacturing
- Transportation equipment manufacturing (vehicles, aircraft, ships, rail)
- Furniture and miscellaneous product manufacturing

**Commonly overlooked applications:**
- Demand planning and inventory optimization across supply-demand mismatch
- Quality control and statistical process control (SPC) — detecting defects, root-cause analysis
- Predictive maintenance and equipment failure prediction
- Energy optimization in process-intensive sectors (steel, chemicals, food processing)
- Supplier quality and supply continuity management
- Production scheduling and constraint management (Theory of Constraints, Lean, Six Sigma have addressed this for decades, but challenges remain in complex multi-product environments)

**Hidden opportunity patterns:**
- Globalization of supply chains creates geographic and temporal coordination complexity
- Just-in-time (JIT) and lean manufacturing reduce buffers, creating brittleness to disruption
- Customization pressure (mass customization) conflicts with efficiency, creating product-mix JTBD
- Upskilling and retention of manufacturing workforce amid automation and offshoring
- Regulatory fragmentation across geographies (environmental standards, labor rules, safety codes)

---

### 42 — Wholesale Trade

**Code range:** 424–425

**Core definition:** Intermediation of goods between manufacturers and retailers. Includes merchant wholesalers (buy and resell), agents/brokers (facilitate without taking title), and drop-shipping.

**Core activities:**
- Merchant wholesale of motor vehicles and parts
- Merchant wholesale of furniture, home furnishings
- Merchant wholesale of grocery and related products
- Merchant wholesale of textiles, apparel, accessories
- Merchant wholesale of hardware, plumbing, heating equipment
- Merchant wholesale of machinery, equipment, supplies
- Merchant wholesale of sporting goods, toys, hobby items
- Wholesale agents and brokers (commission-based intermediation)

**Commonly overlooked applications:**
- Order aggregation and fulfillment (batching, consolidation, routing)
- Inventory management across multiple distribution centers
- Price optimization and promotional planning
- Channel conflict management (wholesale vs. retail, online vs. offline)
- Returns and reverse logistics (RMA processing, refurbishment)

**Hidden opportunity patterns:**
- Disintermediation risk (manufacturers selling direct to retail or end-consumer, eliminating wholesaler)
- Margin pressure from retail consolidation (Walmart, Amazon reducing supplier base and negotiating power)
- B2B technology adoption lag (many wholesalers still operate on EDI or email)
- Fragmented supplier bases creating data silos (each supplier has different integration, formats, systems)

---

### 44-45 — Retail Trade

**Code range:** 441–455

**Core definition:** Sale of merchandise to end consumers through stores, catalogs, e-commerce, or other channels. Includes motor vehicle dealers, general merchandise, specialty, and nonstore retail.

**Core activities:**
- Motor vehicle and parts dealers and service stations
- Furniture and home furnishings stores
- Electronics and appliance stores
- Clothing, accessory, shoe stores
- Sporting goods, hobby, book, music stores
- General merchandise stores (department stores, warehouse clubs, dollar stores)
- Grocery stores, supermarkets
- Specialty food stores (bakeries, butchers, delicatessens)
- Nonstore retail (e-commerce, direct mail, vending machines, door-to-door)

**Commonly overlooked applications:**
- Foot traffic prediction and store layout optimization
- Dynamic pricing and promotion (personalization, A/B testing at scale)
- Inventory visibility and allocation across stores (balancing stock-outs and overstock)
- Omnichannel fulfillment (store pickup, ship-from-store, buy-online-return-in-store)
- Customer attribution across touchpoints (online research, in-store purchase, etc.)
- Labor scheduling and demand (high variability, part-time workforce)

**Hidden opportunity patterns:**
- Amazon effect: e-commerce upends store-centric model, creating existential JTBD for traditional retail
- Experience economy shift: physical stores must compete on experience, not just selection/price
- Supply chain visibility: many retailers still lack end-to-end visibility from supplier through last-mile delivery
- Private-label expansion as margin strategy, creating sourcing and quality JTBD

---

### 48-49 — Transportation & Warehousing

**Code range:** 481–493

**Core definition:** Movement of goods and people, and storage of goods. Includes air, rail, water, road freight and passenger services, pipelines, and warehousing/storage.

**Core activities:**
- Air transportation (scheduled passenger, freight, charter)
- Rail transportation (freight, passenger)
- Water transportation (ocean freight, inland waterways, ports)
- Truck transportation (long-haul, local delivery, specialized)
- Public transit and ground passenger transportation
- Pipeline transportation (crude oil, refined products, natural gas)
- Scenic and sightseeing transportation
- Support activities for transportation (port operations, terminal services, freight forwarding, logistics)
- Warehousing and storage (general, specialized: temperature-controlled, hazmat, etc.)

**Commonly overlooked applications:**
- Route optimization and driver utilization (dynamic routing, load consolidation)
- Real-time visibility and exception management (shipment tracking, delay prediction)
- Asset utilization (vehicle utilization rates, equipment downtime)
- Freight consolidation and modal selection (optimizing across truck/rail/air/sea tradeoffs)
- Port congestion and berth allocation (ship scheduling, cargo loading sequencing)
- Last-mile delivery efficiency (urban delivery in crowded cities, final-mile cost is 50%+ of total)

**Hidden opportunity patterns:**
- Autonomous vehicle (AV) transition: massive capital and employment disruption over next 10-20 years
- E-commerce and same-day delivery explosion creating unsustainable last-mile economics
- Supply chain fragmentation post-COVID creating nearshoring and regional logistics JTBD
- Sustainability pressure: electrification, carbon accounting, modal shift to rail/water

---

### 51 — Information

**Code range:** 511–518

**Core definition:** Creation, processing, transmission, and dissemination of information using technology. Includes publishing, software, telecommunications, data processing, and digital media.

**Core activities:**
- Publishing (newspapers, periodicals, books, software, databases, directories)
- Motion picture and sound recording production and distribution
- Broadcasting and content delivery (television, radio, streaming)
- Telecommunications (telephone, internet, cable, satellite)
- Data processing, hosting, and related services
- Other information services (news syndicates, libraries, archives)

**Commonly overlooked applications:**
- Content recommendation and personalization (Netflix problem: what to watch next, at scale)
- Cybersecurity and threat detection (insider threat, breach detection, incident response)
- Content moderation at scale (removing illegal or policy-violating content from millions of pieces daily)
- Copyright and licensing compliance (monitoring unauthorized distribution)
- Digital infrastructure and uptime (managing redundancy, disaster recovery, geographic distribution)
- Privacy-preserving analytics (GDPR, CCPA compliance while retaining data utility)

**Hidden opportunity patterns:**
- Content creator fragmentation: individuals (YouTubers, podcasters) vs. traditional studios competing for attention
- Advertising model disruption: ad-blocking, privacy changes (Apple iOS tracking), regulatory pressure threatening traditional digital ad economics
- Streaming wars: proliferation of platforms creating fragmentation and creating "password sharing" JTBD
- Data gravity: massive data volumes creating infrastructure and cost optimization JTBD

---

### 52 — Finance & Insurance

**Code range:** 521–525

**Core definition:** Management of financial assets, provision of credit, and transfer of risk through insurance. Includes banks, investment firms, credit unions, insurance carriers, and supporting services.

**Core activities:**
- Depository credit institutions (commercial and savings banks)
- Non-depository credit institutions (finance companies, credit unions)
- Securities and commodity brokers, exchanges
- Investment banking and portfolio management
- Insurance carriers (life, health, property, casualty, reinsurance)
- Insurance agents and brokers
- Funds and trusts (pension funds, mutual funds, hedge funds)
- Financial transaction processing (payment processors, custodians, clearinghouses)

**Commonly overlooked applications:**
- Credit risk assessment and pricing (predicting default, loss-given-default)
- Anti-money laundering (AML) and Know Your Customer (KYC) compliance (regulatory burden, false positive rates)
- Fraud detection and prevention (real-time, across channels, balancing security and friction)
- Claims processing and fraud investigation (insurance)
- Regulatory reporting and stress testing (Basel III, Dodd-Frank compliance)
- Customer identity management and verification at scale

**Hidden opportunity patterns:**
- Fintech disruption: startups offering faster, cheaper, more user-friendly alternatives to legacy institutions
- Regulatory tightening post-2008 financial crisis increasing compliance costs (pushing efficiency JTBD)
- Open banking and API-driven integration (PSD2 in EU, Open Banking Standard in UK) requiring API-first architecture
- Cryptocurrency and blockchain creating new regulatory ambiguity and operational JTBD
- Wealth inequality and retirement savings crisis creating demand for affordable financial services

---

### 53 — Real Estate, Rental, Leasing

**Code range:** 531–532

**Core definition:** Ownership, leasing, and management of real estate and personal property. Includes residential and commercial property management, equipment rental and leasing.

**Core activities:**
- Lessor of residential buildings and dwellings
- Lessor of non-residential buildings
- Lessors of mini-warehouses and storage units
- Lessors of real property (land, parking lots)
- Rental and leasing of automobiles, trucks, construction equipment, medical equipment
- Leasing of aircraft, rail cars, shipping containers
- Real estate agents and brokers
- Real estate property managers and appraisers
- Franchisors and franchise support services

**Commonly overlooked applications:**
- Property valuation and pricing (hedonic pricing, comparable sales analysis)
- Tenant screening and background verification (credit, rental history, criminal)
- Maintenance request prioritization and scheduling (thousands of units, limited staff)
- Rent collection and arrears management
- Equipment tracking and condition monitoring (for rental fleet)
- Lease negotiation and contract management

**Hidden opportunity patterns:**
- Housing shortage in developed markets creating affordability JTBD
- Asset ownership shift: shared economy changing ownership to short-term rental (Airbnb disrupting hotels, Turo disrupting car rentals)
- Proptech disruption: technology enabling direct landlord-tenant relationships, property management automation
- Environmental standards tightening (energy efficiency, carbon emissions) creating retrofit JTBD
- Eviction prevention and rental assistance creating new regulatory JTBD post-COVID

---

### 54 — Professional, Scientific, Technical Services

**Code range:** 541–542

**Core definition:** Specialized professional services requiring advanced education or expertise. Includes architecture, engineering, accounting, legal, consulting, R&D, and specialized design and analysis.

**Core activities:**
- Legal services (law firms, attorneys, document preparation)
- Accounting and bookkeeping services
- Architectural, engineering, and related services
- Specialized design services (graphic, industrial, fashion design)
- Computer systems design and integration services
- Management, scientific, and technical consulting
- Scientific research and development (R&D)
- Advertising and public relations services
- Other professional and technical services (veterinary, environmental consulting, translation)

**Commonly overlooked applications:**
- Time tracking and billable hours (especially in legal and consulting)
- Document management and version control (legal discovery, contracts, regulations)
- Knowledge management and institutional memory (firms losing IP when experts leave)
- Client relationship management (CRM) adapted for professional services (long sales cycles, relationship-based)
- Project costing and profitability analysis (managing multiple projects, multiple team members, fixed vs. variable costs)
- Regulatory compliance documentation (SOX compliance for public company audits, export control documentation for engineering)

**Hidden opportunity patterns:**
- Unbundling of professional services: traditionally bundled services (law firm offering litigation, real estate, corporate) facing pressure from specialists
- Alternative fee arrangements: moving from time-based billing to value-based or hybrid models
- Globalization of services: offshore development and delivery challenging domestic professional service providers
- Automation and commoditization: routine legal documents, tax forms, basic accounting tasks being automated or offshored
- Talent retention: key person risk in expertise-driven firms

---

### 55 — Management of Companies, Enterprises

**Code range:** 551

**Core definition:** Holding companies, corporate management offices, and parent companies that own subsidiaries but engage in no separate business operations themselves.

**Core activities:**
- Holding companies (owning stock in subsidiaries)
- Corporate management offices (CFO office, strategic planning, investor relations)
- Franchise headquarters (providing support to franchisees)

**Commonly overlooked applications:**
- Portfolio management across subsidiary companies (diversification, resource allocation)
- Intercompany transaction management and consolidation (tax optimization, transfer pricing)
- Information systems governance across decentralized units
- Compliance and risk management at corporate level (FCPA, anti-bribery, SOX)

**Hidden opportunity patterns:**
- Activist investor pressure creating shareholder value optimization JTBD
- ESG (Environmental, Social, Governance) reporting and verification requirements
- Corporate restructuring (M&A, spin-offs, divestitures) creating temporary operational complexity

---

### 56 — Administrative, Support, Waste Management

**Code range:** 561–562

**Core definition:** Support services to other organizations, including office administration, human resources outsourcing, customer service outsourcing, and waste management.

**Core activities:**
- Office administrative services (mail, receptionist, office cleaning)
- Human resources and employment services (staffing, temp agencies, HR consulting)
- Facilities support services (security, janitorial, grounds maintenance)
- Business process outsourcing (call centers, customer service, claims processing)
- Travel arrangement and reservation services
- Investigation and security services
- Waste collection, treatment, and disposal
- Remediation and waste management services

**Commonly overlooked applications:**
- Temp worker matching and qualification (skills, availability, geographic fit)
- Staffing level forecasting and scheduling (matching demand volatility)
- Customer service escalation and first-contact resolution (reducing repeat contacts)
- Waste stream optimization (landfill diversion, recycling coordination, hazmat disposal)
- Security incident detection and response

**Hidden opportunity patterns:**
- Gig economy growth creating demand for flexible workforce management platforms
- Regulatory tightening on worker classification (W-2 vs. 1099, benefits eligibility)
- Environmental regulations on waste (Extended Producer Responsibility, circular economy)
- Labor shortage driving wage pressure and automation in low-skill service roles

---

### 61 — Educational Services

**Code range:** 611–612

**Core definition:** Provision of education and training at all levels, from pre-K through higher education, adult education, and specialized training.

**Core activities:**
- Elementary and secondary schools (public, private)
- Colleges and universities
- Junior colleges (2-year)
- Professional and trade schools (vocational, technical)
- Adult education and training (continuing education, workforce development)
- Language schools and tutoring
- Educational support services (testing, educational consulting, curriculum development)

**Commonly overlooked applications:**
- Student learning outcome measurement and adaptive learning (personalization at scale)
- Attendance tracking and intervention (early warning systems for at-risk students)
- Student loan management and repayment (default prevention)
- Admissions and enrollment management (yield optimization, demographic target matching)
- Faculty performance evaluation and compensation (tenure decisions, merit pay)
- Curriculum management and accreditation compliance (courses evolving faster than accreditation cycles)

**Hidden opportunity patterns:**
- EdTech disruption: online courses and MOOCs (Massive Open Online Courses) challenging traditional university model
- Outcomes pressure: states and employers demanding proof of skills acquisition, not just seat-time attendance
- Student debt crisis creating affordability JTBD
- Skill gap between education and employer needs (curriculum lag behind industry)
- Return-on-investment pressure (cost of degree vs. wage premium) creating decision-making JTBD

---

### 62 — Health Care & Social Assistance

**Code range:** 621–624

**Core definition:** Provision of health care services, mental health and substance abuse services, social assistance, and child care.

**Core activities:**
- Offices of physicians, dentists, other health practitioners
- Hospitals (general medical, psychiatric, specialty)
- Ambulatory care services (clinics, urgent care, dialysis centers, imaging centers, surgical centers)
- Home health care services
- Mental health and substance abuse treatment
- Social assistance (child care, family services, elderly care, community development)

**Commonly overlooked applications:**
- Patient appointment scheduling and no-show reduction
- Electronic health record (EHR) interoperability and data exchange (FHIR, HL7)
- Revenue cycle management (billing, coding, claims processing, denials management)
- Supply chain for pharmaceuticals and medical devices (expiration tracking, just-in-time delivery)
- Bed management and patient flow (hospital capacity, ER throughput, operating room scheduling)
- Clinical trial recruitment and patient matching
- Diagnostic accuracy improvement (radiology interpretation, pathology, second opinions)
- Readmission prevention and care coordination (reducing 30-day readmissions)

**Hidden opportunity patterns:**
- Healthcare cost explosion driving efficiency and value-based care JTBD
- Regulatory complexity (HIPAA, MACRA, CMS quality reporting) increasing compliance burden
- Clinician burnout and workforce shortage creating staffing and mental health JTBD
- Social determinants of health awareness (housing, food security, transportation) creating new intervention JTBD
- Pandemic-driven telemedicine adoption creating remote care delivery JTBD

---

### 71 — Arts, Entertainment, Recreation

**Code range:** 711–713

**Core definition:** Creative activities, entertainment events, and recreational activities. Includes performing arts, spectator sports, museums, gambling, recreation, and amusement.

**Core activities:**
- Performing arts companies (theater, dance, orchestras, opera)
- Spectator sports (professional and amateur leagues, events)
- Museums, zoos, botanical gardens
- Gambling casinos and gaming
- Recreation facilities (fitness centers, bowling alleys, golf courses)
- Amusement parks and attractions
- Other entertainment and recreation (gaming, concessions, ticket sales)

**Commonly overlooked applications:**
- Attendance and revenue forecasting (concert attendance, sports ticket sales)
- Dynamic pricing (ticket prices varying by demand, seat location, timing)
- Audience engagement and retention (fan loyalty, season pass renewal)
- Content recommendation and personalization (which shows to see, which games to attend)
- Live event operations (crowd management, safety, parking, concessions)
- Licensing and royalties management (music, video, intellectual property)

**Hidden opportunity patterns:**
- Streaming and digital disruption: traditional content consumption (live entertainment, physical media) declining
- Creator economy: artists and entertainers bypassing traditional distribution (YouTube, TikTok, Twitch)
- Metaverse and virtual events: digital alternatives to physical experiences
- Accessibility and inclusion: making entertainment accessible to disabled audiences
- Labor gig economy: most entertainment workers are independent contractors, creating irregular income JTBD

---

### 72 — Accommodation & Food Service

**Code range:** 721–722

**Core definition:** Provision of temporary lodging and food and beverage preparation and service. Includes hotels, restaurants, catering, bars, and food trucks.

**Core activities:**
- Hotels, motels, and other lodging (bed & breakfast, vacation rentals, RV parks)
- Food service (restaurants, cafeterias, caterers)
- Drinking places and bars
- Food trucks and temporary food service

**Commonly overlooked applications:**
- Reservation management and yield optimization (room pricing, booking patterns)
- Staff scheduling and labor management (high seasonal variability, part-time workforce)
- Food cost management and waste reduction (spoilage, over-ordering)
- Customer feedback and review management (online reputation, complaint resolution)
- Occupancy forecasting and dynamic pricing
- Inventory management for perishables (FIFO, expiration tracking)
- Supply chain for F&B (vendor relationships, product specifications, cost control)

**Hidden opportunity patterns:**
- Sharing economy disruption: Airbnb, Uber Eats, DoorDash disrupting traditional hotel and restaurant models
- Labor shortage and wage pressure (hospitality notoriously low-wage, high-turnover)
- Food safety and allergen management (compliance with increasing regulations)
- Sustainability pressure: reducing plastic, food waste, energy consumption
- Post-COVID recovery: demand patterns shifted (fewer business travelers, more remote work food delivery)

---

### 81 — Other Services

**Code range:** 811–814

**Core definition:** Miscellaneous repair, maintenance, and personal services not classified elsewhere. Includes vehicle repair, appliance repair, laundry, personal care, and civic organizations.

**Core activities:**
- Automotive repair and maintenance
- Electronic and precision equipment repair
- Appliance and furniture repair and upholstery
- Clothing and shoe repair
- Laundry and drycleaning services
- Personal care services (barbering, hair, nail salons, spa)
- Civic organizations and unions
- Other repairs (shoe repair, watch repair, jewelry repair)

**Commonly overlooked applications:**
- Appointment scheduling and queue management
- Technician dispatch and scheduling (especially for mobile services)
- Repair diagnostic and troubleshooting (matching customer problem to solution)
- Parts inventory and supply chain
- Customer communication and status updates (when will my car be ready?)
- Warranty and service agreement management

**Hidden opportunity patterns:**
- Right-to-repair movement: fighting manufacturer restrictions on repair and parts
- Sustainability through repair: extending product life vs. replacement
- Skill shortage: fewer people learning trade skills, traditional apprenticeships declining
- Gig economy service platforms (TaskRabbit, Handy) disrupting local service providers

---

### 92 — Public Administration

**Code range:** 921–928

**Core definition:** Government agencies and administration at federal, state, and local levels. Includes legislative, executive, judicial, military, and administrative services.

**Core activities:**
- Legislative bodies (Congress, state legislatures, city councils)
- Executive offices (Presidency, Governor, Mayor, agency heads)
- Judicial and legal services (courts, attorneys general, public defenders)
- Public order and safety (police, fire, corrections, courts)
- Administration of human resource programs (Social Security, unemployment insurance, Medicare)
- Administration of environmental and conservation programs
- Administration of economic programs (commerce, trade, labor standards)
- Administration of education, public health, housing, transportation, utilities, international relations

**Commonly overlooked applications:**
- Permitting and licensing (issuance, renewal, compliance tracking, appeals)
- Public records management and FOIA (Freedom of Information Act) request processing
- Budget planning and fiscal management (revenue forecasting, expenditure control)
- Employee management and benefits administration (payroll, health insurance, retirement)
- Citizen services (call centers, complaint resolution, case tracking)
- Compliance and auditing (internal audit, external audit, fraud prevention)

**Hidden opportunity patterns:**
- Digital government modernization: outdated IT systems, legacy mainframes, paper processes
- Interagency data sharing and coordination (breaking down silos, enabling integrated services)
- Transparency and accountability: citizen access to government data and decisions
- Regulatory compliance and rule-making (notice-and-comment process, rule impact analysis)
- Public-private partnerships and procurement (contracting, vendor management)

---

## ISIC (International Standard Industrial Classification) — Non-North American Alternative

If scanning markets outside North America, use ISIC (United Nations International Standard Industrial Classification). The structure differs slightly from NAICS:

**ISIC Divisions (analogous to NAICS top-level):**
- A: Agriculture, Forestry, Fishing
- B: Mining and Quarrying
- C: Manufacturing
- D: Electricity, Gas, Steam, Air Conditioning Supply
- E: Water Supply, Sewerage, Waste Management
- F: Construction
- G: Wholesale and Retail Trade, Repair of Motor Vehicles
- H: Transportation and Storage
- I: Accommodation and Food Service
- J: Information and Communication
- K: Financial and Insurance Activities
- L: Real Estate Activities
- M: Professional, Scientific, Technical Activities
- N: Administrative and Support Service Activities
- O: Public Administration and Defense
- P: Education
- Q: Human Health and Social Work Activities
- R: Arts, Entertainment, Recreation
- S: Other Service Activities
- T: Activities of Households as Employers
- U: Activities of Extraterritorial Organizations

**NAICS-to-ISIC mapping:**
- NAICS 11 (Ag) → ISIC A
- NAICS 21 (Mining) → ISIC B
- NAICS 22 (Utilities: electric) → ISIC D
- NAICS 22 (Utilities: water) → ISIC E
- NAICS 23 (Construction) → ISIC F
- NAICS 31-33 (Manufacturing) → ISIC C
- NAICS 42, 44-45 (Wholesale, Retail) → ISIC G
- NAICS 48-49 (Transportation, Warehousing) → ISIC H
- NAICS 51 (Information) → ISIC J
- NAICS 52 (Finance, Insurance) → ISIC K
- NAICS 53 (Real Estate, Rental) → ISIC L
- NAICS 54 (Professional Services) → ISIC M
- NAICS 56 (Support Services) → ISIC N
- NAICS 61 (Education) → ISIC P
- NAICS 62 (Health Care, Social Services) → ISIC Q
- NAICS 71-72 (Arts, Entertainment, Food) → ISIC R, I
- NAICS 92 (Public Admin) → ISIC O

Use ISIC when your capability has application outside North America. Map ISIC findings back to NAICS equivalent for consistency in the final portfolio.

---

## Jobs-to-be-Done (JTBD) Framework: Extended

The JTBD framework, introduced by Clayton Christensen and developed by Strategyn (Outcome-Driven Innovation), classifies customer jobs into three types and assesses the current solution state for each.

### Job Types

**Functional Job:**
- What task is the customer trying to accomplish? What problem must be solved?
- Example: "Get from home to office on time" (transportation), "Preserve documents for 40 years" (archival), "Reduce hospital readmissions by 20%" (health care provider)
- Functional jobs are task-focused. They have measurable outcomes and explicit constraints.
- Most products address functional jobs; this is the baseline.

**Emotional Job:**
- What feeling does the customer want to achieve or avoid?
- Example: "Feel in control of my finances" (banking), "Be seen as innovative by my peers" (tech adoption), "Reduce anxiety about my child's safety" (parenting)
- Emotional jobs are identity, status, or psychological. They are satisfied by how a solution *makes you feel*, not what it does.
- Emotional jobs are often the true decision driver, even when customers rationalize based on functional criteria.

**Social Job:**
- How does the customer want to be perceived by others?
- Example: "Be seen as a successful entrepreneur" (business), "Support my family and be a good provider" (employment), "Contribute to environmental sustainability" (consumer choice)
- Social jobs are about status, identity, or group belonging.
- Boundary: emotional jobs are private (how you feel), social jobs are public-facing (how others perceive you).

### Solution State Classification

**Overserved Job:**
- Definition: Customers have solutions that exceed what they need. The solution is overfeatured, overcomplicated, or higher-quality than the job requires.
- Symptom: Customers are willing to downgrade to a simpler, cheaper alternative if it covers the essential needs.
- Example: High-end restaurant for a quick weekday lunch (overserved functional job—customer just needs food fast, not culinary experience). Microsoft Word for writing a brief email (overserved—customer needs to draft text, not formatting/styles/collaboration).
- Implication: The opportunity is *simplification* or *commoditization*, not feature addition.

**Underserved Job:**
- Definition: Customers struggle with existing solutions. The solution is too slow, too expensive, too complicated, or doesn't exist at all, forcing costly workarounds.
- Symptom: Customers spend time, money, or effort on manual alternatives or hire people to fill the gap.
- Example: Coordinating schedules across geographically distributed teams before Slack/async communication tools. Managing cash flow as a small business without real-time visibility (pre-cloud accounting).
- Implication: The opportunity is *relief* on the blocking metrics (speed, cost, accuracy, scale, accessibility).

**Non-Consumed Job:**
- Definition: No solution exists that is accessible or affordable to the customer. The job goes undone or is done in a primitive way, leaving value on the table.
- Symptom: Market is latent or unaddressed. Customers have not formed habits or expectations because no good option was available.
- Example: Low-income borrowers before microfinance had no access to credit (non-consumed). Remote workers before Zoom/Teams had no practical way to collaborate synchronously across distance.
- Implication: The opportunity is *enablement*—making something possible that was previously impossible.

### Outcome-Driven Innovation (ODI) Extension

ODI adds measurable outcome metrics to JTBD analysis. For any functional job, customers prioritize among these outcome dimensions:

| Metric | Definition | Example JTBD |
|--------|-----------|-----------|
| **Speed** | How fast is the task completed? | Reduce approval time from 3 weeks to 3 days |
| **Accuracy** | How reliable or error-free is the outcome? | Reduce diagnostic error rate from 5% to <1% |
| **Cost** | What is the total cost (money, time, effort, risk)? | Cut implementation cost by 40% |
| **Scale** | Can the solution work at the volume/size needed? | Handle 10,000 simultaneous users without degradation |
| **Reliability** | How consistently does it work across conditions? | 99.99% uptime (4 nines) |
| **Ease of use** | How much skill, training, or effort is required? | No specialized certification to operate |

For any given job, customers prioritize 2–3 of these metrics. Others are hygiene factors (must-haves but not decision drivers).

**ODI analysis for JTBD assessment:**
1. For each candidate industry-activity pair, identify the functional job.
2. Ask: "Which 2–3 outcome metrics matter most for this job?"
3. Ask: "Where is the worst outcome today?" (slowest, most error-prone, most expensive, most limited scale, least reliable, hardest to use)
4. Ask: "Can the capability move that worst outcome dramatically?"

**Example:** In hospital operating room scheduling, the functional job is "allocate surgeons and ORs to maximize throughput while respecting surgeon preferences and patient urgency." Outcome metrics:
- Speed: How fast can cases be scheduled after intake?
- Scale: How many cases/ORs can be managed simultaneously?
- Reliability: How often does the schedule need re-work due to emergencies or cancellations?

If the worst outcome today is reliability (schedule fragility, 20% re-work), and the capability enables real-time re-optimization, that's a strong relief signal.

---

## Constraint-Relief Mapping: Extended Framework

Constraint-relief mapping identifies the specific bottlenecks blocking progress in a domain and assesses whether the capability provides relief.

### Six Constraint Types and Diagnostic Questions

#### Cost Constraint
- **Diagnostic questions:**
  - What prevents wider adoption today? Is the blocker the expense of the current solution, or the inability to afford any solution at all?
  - How do cost constraints vary by customer segment? (Startup vs. enterprise? Developing vs. developed market?)
  - Is cost the primary constraint, or is it secondary to another bottleneck? (Cost may be a symptom, not the root cause.)
  
- **Relief mechanism:**
  - Capability reduces the cost of the current solution (e.g., automation reduces labor cost, reusable components reduce custom build cost).
  - Capability enables a low-cost alternative path (e.g., cloud-based solution vs. on-premises infrastructure investment).
  - Capability enables outcome at a different cost-quality tradeoff (e.g., "good-enough" solution at 1/10 the cost of perfect solution).

- **Example:** Radiology interpretation is expensive because of high-skill labor requirements. An AI model that flags high-confidence anomalies (complete relief) or assists radiologists in review (substantial relief) reduces the cost per study.

#### Speed Constraint
- **Diagnostic questions:**
  - Is slowness a friction point? Do customers wait, buffer, or pay premium for expedited service?
  - What is the cost of delay? (Does delay create cascading failures, missed opportunities, or just frustration?)
  - What is the current bottleneck? (Is the process slow end-to-end, or is there one slow step?)

- **Relief mechanism:**
  - Capability parallelizes sequential steps (e.g., reviewing applications in parallel instead of serial review).
  - Capability eliminates a slow step (e.g., removing manual approval gates).
  - Capability enables predictive action (e.g., start preparing for next step before current step is done).

- **Example:** Hospital discharge takes 2 hours post-procedure because of paperwork, prescriptions, and appointment scheduling. A capability that pre-populates discharge forms and auto-schedules follow-up appointments reduces the bottleneck from 120 minutes to 20 minutes (substantial relief).

#### Accuracy Constraint
- **Diagnostic questions:**
  - Where does error have high cost? (Patient harm, financial loss, regulatory penalty, reputation damage?)
  - What is the current error rate? Is it acceptable, or does it drive workarounds or rework?
  - Can error be reduced without sacrificing speed or cost?

- **Relief mechanism:**
  - Capability detects errors before they propagate (e.g., data validation catching bad input upstream).
  - Capability reduces the probability of error in a high-risk step (e.g., clinical decision support reducing diagnostic errors).
  - Capability enables verification at scale (e.g., automated code review catching bugs before human review).

- **Example:** Pathology diagnosis error rate is 2–3% despite expert review. An AI-assisted review tool that flags atypical cases for senior pathologist verification reduces error rate to <1% (substantial relief on accuracy metric).

#### Scale Constraint
- **Diagnostic questions:**
  - Does the current solution break down at higher volume? Is throughput bottlenecked?
  - What volume is needed vs. what is currently achievable? (Can we do 1,000 units but need 10,000?)
  - What happens if you try to scale? (Cost escalation, quality degradation, coordination breakdown?)

- **Relief mechanism:**
  - Capability enables work that was previously impossible at needed scale (true non-consumed job relief).
  - Capability reduces the cost-per-unit as you scale (e.g., economies of scale enabled by automation).
  - Capability enables parallel scaling (e.g., cloud infrastructure vs. on-premises).

- **Example:** Manual supplier quality audits can cover ~50 suppliers per year. A capability that analyzes supplier quality data in real-time can assess 500+ suppliers continuously (10x scale improvement).

#### Accessibility Constraint
- **Diagnostic questions:**
  - Who is excluded from this capability today? (Expertise required? Geography limited? Language barriers? Disability?)
  - Is accessibility a secondary issue, or is it blocking a major population's access to value?
  - What is the cost or effort barrier to access?

- **Relief mechanism:**
  - Capability removes expertise requirement (e.g., democratizing financial planning, legal document drafting, medical diagnosis).
  - Capability removes geographic barrier (e.g., telemedicine, remote work, global e-commerce).
  - Capability enables accessibility for disabled users (e.g., voice control, screen reader optimization, captions).
  - Capability enables access for underserved languages or cultures.

- **Example:** Legal document drafting requires expensive attorneys. A capability that guides non-lawyers through document creation (templated, plain-language) democratizes access (substantial relief on accessibility).

#### Regulatory Constraint
- **Diagnostic questions:**
  - Does compliance prevent adoption of current solutions? Are there solutions that would work but are blocked by regulation?
  - What is the compliance cost (reporting, audit, legal review)?
  - Are regulations tightening (creating future compliance JTBD) or loosening?

- **Relief mechanism:**
  - Capability reduces compliance cost (e.g., automating regulatory reporting, audit trails).
  - Capability enables compliance that was previously hard or impossible (e.g., GDPR-compliant data sharing, export-control compliance).
  - Capability enables new business model within regulatory constraints (e.g., telemedicine where in-person-only rules were the constraint).

- **Example:** Financial institutions must perform Know Your Customer (KYC) checks, but manual KYC is slow and expensive. A capability that automates KYC (government ID verification, sanctions list checking) reduces cost and increases speed (substantial relief on cost and speed).

### Relief Assessment Scale

Rate the magnitude of relief provided:

| Relief Level | Definition | Signal Strength |
|-------------|-----------|----------------|
| **Complete Relief** | Capability removes the constraint entirely. Before: blocking adoption. After: constraint is no longer a factor. | Very strong. This is a non-consumed or seriously underserved job where the capability enables something previously impossible. |
| **Substantial Relief** | Constraint still exists but is dramatically less severe. Before: 1-year process, $1M cost. After: 1-month process, $100K cost. | Strong. Customers prioritize this outcome and will adopt if other constraints are acceptable. |
| **Partial Relief** | Constraint is improved but still limits adoption or value capture. Before: 2 weeks. After: 1 week. | Moderate. Useful in combination with other improvements, but may not drive adoption alone. |
| **Marginal Relief** | Capability helps at the edges but doesn't move the needle on the main bottleneck. | Weak. Rarely sufficient to justify adoption unless other factors are compelling. |

---

## Analogical Reasoning Protocol: Domain Distance Heuristic

When identifying analogous industries for a given capability or JTBD, use the domain distance heuristic to prioritize novel connections and assess analogy strength.

### Domain Distance Scale

| Distance | Definition | Example Pair | Signal Strength |
|----------|-----------|-------------|-----------------|
| **Adjacent (1)** | Industries that frequently interact or are part of the same value chain. Customers/operations span both domains. | Food manufacturing → Food service; Automotive parts → Automotive assembly | Highest confidence but least novel insight. Analogies are often obvious and already exploited. |
| **Related (2)** | Industries that share customers, similar workflows, or competitive dynamics, but don't directly touch. | Insurance → Banking; Retail → E-commerce | Good balance of novelty and confidence. The solution mechanism is likely to transfer with modest adaptation. |
| **Distant (3)** | Industries that appear structurally unrelated; few overlapping customers or processes. | Agriculture → Cybersecurity; Hospitality → Pharmaceutical manufacturing | Higher novelty, lower confidence. Solution mechanisms may not transfer directly. But if the structural analogy holds, the insight is valuable. |
| **Alien (4)** | Industries from completely different domains (e.g., biology, physics, military, ecology) not classified in NAICS. | Immune system response → Corporate security incident response; Ant colony logistics → Supply chain routing | Highest novelty, lowest confidence. But when analogies hold at this distance, they reveal patterns invisible within traditional industry thinking. |

### Analogical Reasoning Protocol

1. **Identify the primary JTBD or constraint:** "What is the core job that needs relief?"
   - Example: "Coordinate distributed activities under time pressure with incomplete information and limited real-time feedback."

2. **Strip domain-specific content:** Remove nouns (hospital, aircraft, supply chain) and focus on the abstract structure.
   - Abstract structure: "Multiple agents operate on incomplete information, must coordinate actions despite latency and uncertainty, and must detect and adapt to failures in real-time."

3. **Search distant domains first:**
   - Start at Domain Distance 4 (alien): biology, military, physics, ecology, game theory, network science, sociology, music theory.
   - Work toward Domain Distance 1 (adjacent) only if distant matches fail.

4. **For each domain distance, find 2–3 examples:**
   - "In [source domain], the [source problem] maps to our [target job] because [structural parallel]."
   - Example: "In military logistics (alien distance), coordinating supply delivery across a theater of operations with fragmentary intelligence and adversarial disruption maps to our hospital supply chain problem because both require dynamic replanning under incomplete information and must tolerate cascading failures."

5. **Prioritize convergence:** If multiple distant domains have converged on the same solution class, that's the strongest signal.
   - Example: "Immune systems, aircraft maintenance, and urban traffic management all converged on 'detect-respond-adapt' cycles with distributed sensing and local control. If the capability enables this cycle, it likely transfers across all three domains."

---

## References for Backflow Analysis

The Backflow Check (Step 5) flags warning conditions that suggest either over-matching, narrow applicability, or domain-specificity. Use these flags to evaluate whether the domain scan has found a genuinely broad-spectrum capability or a narrowly-focused one.

### Backflow Flag Thresholds

1. **Secondary Capability Overmatch:**
   - Threshold: Secondary capabilities produce 40%+ as many matches as the primary capability.
   - Implication: Either the primary capability is overstated in scope, or the secondary capability is the real opportunity. Consider re-framing.

2. **Homefield Clustering:**
   - Threshold: >50% of matches come from industries within 1 NAICS hop of the home domain.
   - Implication: The capability may be narrowly applicable to the home domain and adjacent sectors. Genuine cross-domain relevance should show distribution across Domain Distance 2-4.

3. **JTBD Type Leakage:**
   - Threshold: >70% of matches fall in one JTBD category (e.g., >70% are functional, <10% are emotional or social).
   - Implication: Narrow applicability. A broadly useful capability should enable functional, emotional, and social jobs across different customer segments.

4. **Relief Magnitude Degradation:**
   - Threshold: Average relief assessment for distant domains (Distance 3-4) is more than one tier below adjacent/related domains (Distance 1-2).
   - Implication: The capability is most valuable near home. Distant-domain applications may be speculative or require significant adaptation.

### Backflow Assessment

- **No flags:** Capability shows genuine cross-domain relevance, broad JTBD coverage, and consistent relief magnitude. Suitable for deep research across portfolio.
- **1 flag:** Minor concern; investigate the flagged condition but proceed with portfolio development.
- **2+ flags:** Major concern; revisit the capability statement and domain scan. Consider whether the capability is narrowly applicable or whether the scan was insufficiently systematic.

---

## Summary: When to Use This Reference

- **Step 1 (NAICS/ISIC Traversal):** Use the sector definitions, core activities, and hidden opportunity patterns sections to ground your traversal. Check commonly overlooked applications to avoid intuitive filtering.
- **Step 2 (JTBD Analysis):** Use the JTBD Framework Extended and ODI sections to classify jobs, assess solution state, and identify blocking outcome metrics.
- **Step 3 (Analogical Reasoning):** Use the Domain Distance Heuristic and analogical reasoning protocol to find structurally similar industries and rate analogy strength.
- **Step 4 (Constraint-Relief Mapping):** Use the six constraint types and relief assessment scale to evaluate how comprehensively the capability addresses bottlenecks in each candidate domain.
- **Step 5 (Backflow Check):** Use the backflow flag thresholds to assess whether the scan results show genuine cross-domain relevance or signal over-matching and narrow applicability.
