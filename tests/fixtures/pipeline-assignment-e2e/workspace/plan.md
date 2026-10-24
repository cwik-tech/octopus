# Plan: Pipeline Assignment
**Status:** draft

### S1: Assignment Sprint
#### T1: Produce the analysis artifact
- **Agent:** analyst
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** analysis.md

#### T2: Produce the recommendation artifact
- **Agent:** synthesizer
- **Status:** pending
- **Validate:** false
- **Depends on:** T1
- **Gate:** false
- **Result file:** recommendation.md

#### T3: Produce the final report artifact
- **Agent:** synthesizer
- **Status:** pending
- **Validate:** false
- **Depends on:** T2
- **Gate:** false
- **Result file:** final-report.md
