# References

Papers and preprints that shaped OpenMem’s memory interface, context proxy design, and benchmark choices. Narrative mapping to design decisions: [Context research](context-research.md). Trial plans and follow-ups: [Evidence plan](evidence-plan.md).

## Context management and agent memory

- Packer, C., et al. (2023). **MemGPT: Towards LLMs as Operating Systems.** [arXiv:2310.08560](https://arxiv.org/abs/2310.08560)
- An, K., et al. (2024). **LoCoMo: Long-term Conversational Memory for LLMs.** [arXiv:2402.17753](https://arxiv.org/abs/2402.17753)
- Wu, Z., et al. (2024). **LongMemEval: Benchmarking Long-Term Memory in LLMs.** [arXiv:2410.10813](https://arxiv.org/abs/2410.10813)
- Lindenbauer, M., et al. (2025). **The Complexity Trap: Simple Observation Masking Is Competitive with LLM Summarization for Agent Context.** [arXiv:2508.21433](https://arxiv.org/abs/2508.21433)
- (2025). **MemoryAgentBench: Evaluating Memory in LLM Agents.** [arXiv:2507.05257](https://arxiv.org/abs/2507.05257)
- Shao, R., et al. (2025). **Context Language Models.** [arXiv:2609.37725](https://arxiv.org/abs/2609.37725) — includes **ContextBench** ([code](https://github.com/RulinShao/ContextBench), [Harbor tasks](https://github.com/facebookresearch/context-language-models))
- (2026). **Compact-Bench: Task Preservation After Agent Context Compaction.** [arXiv:2610.31710](https://arxiv.org/abs/2610.31710)

## Related reports and benchmarks (not arXiv)

- Chroma (2025). **Context Rot: How Increasing Input Tokens Impacts LLM Performance.** [Research report](https://www.trychroma.com/research/context-rot) · [code](https://github.com/chroma-core/context-rot)
- Letta (2025). **Is a Filesystem All You Need?** LoCoMo evaluation with file-style tools. [Blog post](https://www.letta.com/blog/benchmarking-ai-agent-memory/)
- Anthropic (2025). **Effective context engineering for AI agents.** [Engineering blog](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Anthropic (2025). **Context editing and the memory tool.** [Product blog](https://claude.com/blog/context-management)

## Software we benchmarked against or built on

- [ContextBench](https://github.com/RulinShao/ContextBench) — strict-mode kv-store and log-triage tasks in this repo’s ContextBench runs (Harbor harness; see [context research](context-research.md#benchmark-method))
