---
name: embedding-model-evaluation
description: Compares embedding models (domain-specific vs general, fine-tuning ROI, multilingual performance) on labelled FST domain questions; measures vector quality, cost, and inference latency.
---

# Embedding Model Evaluation

## Purpose

Determine whether a domain-specific or fine-tuned embedding model is justified for an FST knowledge base, or whether general-purpose embeddings (OpenAI text-embedding-3, Cohere, open-source alternatives) are sufficient. Ground the decision in measured retrieval quality on domain terminology and cost-per-embedding at projected volume.

## Methodology

### 1. Prepare the evaluation corpus

- Extract 30–50 representative FST domain questions from early conversations or priority use cases.
- For each question, identify the correct passage(s) in the parsed Markdown corpus.
- Document the FST-specific terminology that the question relies on (product model numbers, process step names, technical parameter names, abbreviations). This is the signal that domain-specific embeddings might outperform general models.
- Aim for diversity: questions that require navigating process steps, product specifications, multilingual retrieval, and technical diagrams.

### 2. Embed and rank

- Generate embeddings using candidate models (e.g., OpenAI text-embedding-3-small, text-embedding-3-large, Cohere embed-english-v3.0, domain-specific fine-tune, open-source alternatives like bge-base-en).
- For each model, rank the top-k passages for each query (typically k=5, 10).
- Measure Recall@1, Recall@5, Recall@10 for each model on the evaluation set.
- Record inference latency (cold start, warm, batch) and per-embedding cost from the provider's pricing.

### 3. Analyze the gap

- For questions where domain models outperform general models, identify the FST terminology at play. Quantify the gap: is it 5% or 50%?
- For questions where both perform equally, confirm that general models capture the intent.
- Calculate cost-benefit: at your baseline query volume, what's the annual cost delta between models? At 2x and 10x volume?
- Document the cost threshold at which the more expensive model becomes economical (e.g., "domain-specific model pays for itself at 100K queries/month").

### 4. Multilingual considerations

- If the FST corpus includes non-English content (e.g., Spanish, German), test embedding quality on multilingual question-passage pairs.
- Measure cross-lingual retrieval: query in English, retrieve passages in Spanish, and vice versa.
- Identify any language-pair gaps (many "multilingual" models excel at high-resource pairs like English-Spanish, fail on low-resource or domain-specific multilingual terminology).

### 5. Recommendation

- Recommend a primary model (e.g., "text-embedding-3-small" or "fine-tuned-fst-domain-v1").
- Document the decision rule: use general model Y unless domain terminology causes >10% quality loss, in which case invest in fine-tuning X.
- State the threshold volume at which a more expensive model becomes cost-justified (e.g., "fine-tune at 500K+ queries/month").
- Document the cost and latency impact of that recommendation on overall retrieval performance.

## Failure modes

- **Vendor claims of 2–3% retrieval improvement** based on generic benchmarks (STS, MTEB) that do not reflect FST domain terminology. Generic benchmarks are not predictive of domain-specific performance.
- **Fine-tuning cost and training latency underestimated.** Fine-tuning requires labelled data (100–1000+ examples), training time (hours to days on GPU), and ongoing retraining as terminology evolves. Amortize over realistic query volume.
- **Multilingual support overstated.** Many "multilingual" models perform well on high-resource languages (English, Spanish, Mandarin) but degrade significantly on domain + low-resource pairs or non-Latin scripts.
- **Inference latency ignored in cost model.** Embeddings must be fast for real-time retrieval. A model that is 10% cheaper but 50% slower may be unacceptable.
- **Lock-in cost underestimated.** Fine-tuning a model locks you into that model's ecosystem (training data, version management, retraining pipelines). Switching costs are high.

## Output

- **Ranking table:** Model name, Recall@1/5/10 on pilot corpus, cost per 1M embeddings, inference latency (p50ms), multilingual gap (if applicable).
- **Decision:** Use general model Y, or invest in fine-tuning/domain-specific model X. At what query volume does cost-benefit flip?
- **Cost model:** Annual cost at baseline (e.g., 100K/month), at 2x, and at 10x volume. Include fine-tuning costs if applicable.
- **Multilingual summary:** Cross-lingual quality gaps, languages where general models underperform.
- **Monitoring:** Which metrics to track post-launch (Recall@5, inference latency, cost per query).
