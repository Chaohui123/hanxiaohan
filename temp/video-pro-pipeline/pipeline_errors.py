class PipelineError(Exception):
    pass


class PlanError(PipelineError):
    pass


class MediaError(PipelineError):
    pass


class TextLayoutError(PipelineError):
    pass


class MediaQCError(PipelineError):
    pass
