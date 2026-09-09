export function Subagents() {
  return (
    <section>
      <h3>
        Subagents
        <span x-show="$store.app.subagents.busy">Working...</span>
        <span x-show="$store.app.subagents.saved">Saved.</span>
      </h3>
      <p class="model-empty">Settings apply to new built-in tasks and self-forks. Main agent settings are unchanged.</p>
      <p class="err" role="alert" x-show="$store.app.subagents.error" x-text="$store.app.subagents.error" />
      <template x-for="row in $store.app.subagents.rows" x-bind:key="row">
        <div class="model-item">
          <div class="model-head">
            <span class="model-title" x-text="row === 'default' ? 'Unified default' : row" />
            <span class="acc-meta" x-show="row !== 'default'" x-text="$store.app.subagents.own(row) ? 'Override' : 'Uses unified default'" />
          </div>
          <p class="acc-meta" x-text="$store.app.subagents.summary(row)" />
          <fieldset class="model-body" x-bind:disabled="$store.app.subagents.busy || !$store.app.subagents.committed">
            <div class="field">
              <label x-bind:for="'subagent-model-' + row">Model</label>
              <select x-bind:id="'subagent-model-' + row" x-bind:value="$store.app.subagents.own(row)?.modelId || ''" x-on:change="$store.app.subagents.setModel(row, $event.target.value)">
                <option value="" x-text="row === 'default' ? 'Keep existing Cursor behavior' : 'Use unified default'" />
                <template x-if="$store.app.subagents.own(row) && !$store.app.subagents.selected(row)">
                  <option x-bind:value="$store.app.subagents.own(row).modelId" x-text="'Missing model: ' + $store.app.subagents.own(row).modelId" />
                </template>
                <template x-for="option in $store.app.subagents.models()" x-bind:key="option.id">
                  <option x-bind:value="option.id" x-text="option.label" />
                </template>
              </select>
            </div>
            <div x-show="$store.app.subagents.own(row)">
              <div class="field-row">
                <div class="field">
                  <label x-bind:for="'subagent-effort-' + row">Reasoning</label>
                  <select x-bind:id="'subagent-effort-' + row" x-bind:value="$store.app.subagents.own(row)?.reasoningEffort || ''" x-on:change="$store.app.subagents.setParameter(row, 'reasoningEffort', $event.target.value)">
                    <option value="">Model default</option>
                    <template x-for="effort in $store.app.subagents.efforts(row)" x-bind:key="effort"><option x-bind:value="effort" x-text="effort" /></template>
                  </select>
                </div>
                <div class="field">
                  <label x-bind:for="'subagent-fast-' + row">Fast</label>
                  <select x-bind:id="'subagent-fast-' + row" x-bind:disabled="!$store.app.subagents.selected(row)?.model.parameters?.fast" x-bind:value="$store.app.subagents.own(row)?.fast === undefined ? '' : String($store.app.subagents.own(row).fast)" x-on:change="$store.app.subagents.setParameter(row, 'fast', $event.target.value)">
                    <option value="">Model default</option>
                    <option value="true">On</option>
                    <option value="false">Off</option>
                  </select>
                </div>
              </div>
              <div class="field">
                <label x-bind:for="'subagent-context-' + row">Context</label>
                <select x-bind:id="'subagent-context-' + row" x-bind:value="$store.app.subagents.own(row)?.contextTokenLimit || ''" x-on:change="$store.app.subagents.setParameter(row, 'contextTokenLimit', $event.target.value)">
                  <option value="">Model default</option>
                  <template x-for="limit in $store.app.subagents.contexts(row)" x-bind:key="limit"><option x-bind:value="limit" x-text="limit" /></template>
                </select>
              </div>
            </div>
          </fieldset>
        </div>
      </template>
      <div class="row">
        <button class="tiny" x-on:click="$store.app.subagents.save()" x-bind:disabled="$store.app.subagents.busy || !$store.app.subagents.dirty()">Save</button>
        <button class="tiny secondary" x-on:click="$store.app.subagents.cancel()" x-bind:disabled="$store.app.subagents.busy || !$store.app.subagents.dirty()">Cancel</button>
        <button class="tiny ghost" x-on:click="$store.app.subagents.load()" x-bind:disabled="$store.app.subagents.busy || $store.app.subagents.dirty()">Reload</button>
      </div>
    </section>
  )
}
