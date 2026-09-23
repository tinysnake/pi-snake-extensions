# pi-snake-extensions

A monorepo of extensions for the pi coding agent.

## Language

**Deferred send**:
The mechanism where a submitted message enters the session only after a confirmation window closes.
_Avoid_: Recall (retrieving a message *after* it was sent — a different feature, out of scope for v1)

**Send countdown**:
The confirmation window between a user's send gesture and the message entering the session.

**Pending send**:
A message that has been confirmed for sending but has not yet entered the session.

**Cancel**:
The outcome of abandoning a pending send before the send countdown ends.
_Avoid_: Recall

**Interrupt**:
Any user input during the send countdown; its result is a cancel.

**Send now**:
A submit gesture that skips the send countdown entirely.

**Double enter**:
A second plain `Enter` pressed during the send countdown at least `doubleEnterSeconds` after the first; it ends the countdown early and sends.
_Avoid_: Send now (which skips the countdown rather than ending an active one)

**Command**:
A slash input that pi executes as an action rather than conversation content.
_Avoid_: Skill invocation, template (both produce messages, not commands)

**Message**:
Text that enters the session and reaches the model, including skill and template expansions.
