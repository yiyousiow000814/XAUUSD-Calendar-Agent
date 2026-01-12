"""Argument defaults + CLI parsing for the stage workflow."""

from __future__ import annotations

import argparse

from .stage_workflow_args_part1 import add_stage_args_part1
from .stage_workflow_args_part2 import add_stage_args_part2
from .stage_workflow_args_part3 import add_stage_args_part3


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run the Stage A calendar workflow: merge minute data with events, "
            "summarise price behaviour, and derive Stage B deep-dive + preheat outputs."
        )
    )

    add_stage_args_part1(parser)
    add_stage_args_part2(parser)
    add_stage_args_part3(parser)

    return parser.parse_args()
