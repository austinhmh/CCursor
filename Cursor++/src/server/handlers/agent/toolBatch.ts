import type { AgentServerMessage } from '../../gen/agent_v1_pb'
import { resolveExecutionToolName } from './tools'
import { finalizeTaskResult, launchTaskTool, runToolCall, type TaskLaunchContext } from './toolRuntime'
import { awaitExecResultAndClose, isAgentRunAbortedError, throwIfSessionCancelled, waitForPromiseWithHeartbeat } from './wait'
import { getToolModeRestriction } from './toolkit/types'
import { finalizeToolCall } from './toolLifecycle'

type ToolBatchParameters = Omit<Parameters<typeof runToolCall>[0], 'toolCall' | 'onModeChanged'> & {
  toolCalls: Array<Parameters<typeof runToolCall>[0]['toolCall']>
  onModeChanged: (mode: string) => void
}

export async function* runToolBatch(params: ToolBatchParameters): AsyncGenerator<AgentServerMessage, void, void> {
  let currentMode = params.mode
  let switchRejected = false
  const taskLaunches: TaskLaunchContext[] = []
  const calls = params.toolCalls.map(toolCall => ({
    toolCall,
    executionName: resolveExecutionToolName(toolCall.name, toolCall.input, params.cursorDynamicTools),
  }))
  const hasModeSwitch = calls.some(call => call.executionName === 'SwitchMode')
  const isTask = (name: string) => name === 'Task' || name === 'Subagent'
  // Preserve ordinary Task fan-out; a mode-switch batch instead respects source order.
  const scheduledCalls = hasModeSwitch
    ? calls
    : [...calls.filter(call => isTask(call.executionName)), ...calls.filter(call => !isTask(call.executionName))]

  async function* finishTasks(): AsyncGenerator<AgentServerMessage, void, void> {
    if (!params.session || taskLaunches.length === 0)
      return
    const session = params.session
    const results = yield* waitForPromiseWithHeartbeat(Promise.all(taskLaunches.map(async (launch) => {
      try {
        return { result: await awaitExecResultAndClose(session, launch.execMessageId) }
      }
      catch (error) {
        if (isAgentRunAbortedError(error))
          throw error
        return { error: error instanceof Error ? error.message : String(error) }
      }
    })))
    throwIfSessionCancelled(session)
    for (const [index, result] of results.entries()) {
      const launch = taskLaunches[index]!
      if ('error' in result) {
        yield finalizeToolCall({
          roundContext: params.roundContext,
          messages: params.messages,
          cursorToolType: launch.cursorToolType,
          toolName: launch.tc.name,
          callId: launch.tc.callId,
          startedArgs: launch.startedArgs,
          rawToolResult: { result: { case: 'error', value: { error: result.error } } },
          input: launch.sanitizedInput,
          modelCallId: launch.modelCallId,
        }).frame
      }
      else {
        yield finalizeTaskResult(launch, result.result, params.roundContext, params.messages, session)
      }
    }
    taskLaunches.length = 0
  }

  for (const { toolCall, executionName } of scheduledCalls) {
    if (params.session)
      throwIfSessionCancelled(params.session)
    if (hasModeSwitch && !isTask(executionName))
      yield* finishTasks()
    if (params.session)
      throwIfSessionCancelled(params.session)

    if (!switchRejected && isTask(executionName) && params.session
      && !getToolModeRestriction(currentMode, 'taskToolCall')) {
      const launch = yield* launchTaskTool({ ...params, toolCall, mode: currentMode })
      if (launch)
        taskLaunches.push(launch)
      continue
    }

    let modeApproved = false
    yield* runToolCall({
      ...params,
      toolCall,
      mode: currentMode,
      rejectionReason: switchRejected ? 'not_executed: preceding mode switch was not approved' : undefined,
      onModeChanged: (mode) => {
        currentMode = mode
        modeApproved = true
        params.onModeChanged(mode)
      },
    })
    if (executionName === 'SwitchMode' && !modeApproved)
      switchRejected = true
  }
  yield* finishTasks()
}
