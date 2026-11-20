// `orca plugin check` renders the panel once per scenario, each with the worker on a fresh
// host. Seed what the worker reads so check shows more than the first state.
import { defineCheck } from 'orca/testing'

export default defineCheck({
  fresh: {},
  counted: { storage: { total: 41 } }
})
