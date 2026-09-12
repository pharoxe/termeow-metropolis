# Advanced Trench Trader Interview

**Purpose:** Capture the decision-making, pattern recognition, risk controls, and execution rules of an advanced onchain trader for the Termeow agent.

**Estimated time:** 15–20 minutes
**Format:** Voice interview using one winning trade and one losing trade as references. Use real examples instead of general theory wherever possible.

---

## 1. Finding the Trade — 3 minutes

1. Think of a recent strong winner. What first brought it onto your radar, and what made you investigate immediately?

   **Answer:**

2. In what order did you evaluate the token before entering?

   **Answer:**

3. Which signal actually converted it from “interesting” into “buy now”?

   **Answer:**

4. What nearly stopped you from taking the trade?

   **Answer:**

5. What do you notice early that most traders recognize too late?

   **Answer:**

---

## 2. Wallet and Social Edge — 3 minutes

6. What makes a wallet genuinely worth tracking rather than merely profitable in hindsight?

   **Answer:**

7. Which matters most: the wallet’s first entry, repeated buys, position size, funding source, or trading history?

   **Answer:**

8. How do you distinguish an informed wallet, insider, coordinated cluster, and lucky buyer?

   **Answer:**

9. How far above a tracked wallet’s entry are you willing to buy? What changes that limit?

   **Answer:**

10. Which social behaviors suggest each of the following?

    - An imminent token launch
    - Genuine conviction
    - A coordinated push
    - Approaching distribution

    **Answer:**

11. When do you fade a well-known trader or KOL instead of following them?

    **Answer:**

---

## 3. Reading the Launch and Chart — 4 minutes

12. During the first few minutes, which signals carry the most weight?

    **Answer:**

13. Describe a healthy first pullback. What makes a visually similar pullback dangerous?

    **Answer:**

14. How do you distinguish organic demand from bundled, wash-traded, or single-wallet volume?

    **Answer:**

15. What does accumulation or absorption look like in thin onchain flow?

    **Answer:**

16. What usually exposes distribution before the chart visibly breaks down?

    **Answer:**

17. When using a Fibonacci retracement, how do you choose the rally’s true swing low and high?

    **Answer:**

18. What additional confirmation makes a 0.618 bounce actionable? What invalidates it?

    **Answer:**

19. Which setups require immediate execution, and which should always wait for a close or reclaim?

    **Answer:**

---

## 4. Execution and Sizing — 3 minutes

20. Explain your sizing formula using wallet percentage or risk units.

    **Answer:**

21. Which factors increase position size, and which reduce it?

    **Answer:**

22. How do liquidity, price impact, and available exit depth change your maximum position?

    **Answer:**

23. When is entering late still acceptable, and when has the edge already disappeared?

    **Answer:**

24. When would you accept unusually high slippage to enter early?

    **Answer:**

25. What could make you cancel after receiving a valid quote but before signing?

    **Answer:**

---

## 5. Managing the Position — 3 minutes

26. What information becomes more important after entry than before it?

    **Answer:**

27. Which conditions make you exit even while price is rising?

    **Answer:**

28. How do you manage an immediate 2× without exiting too early or round-tripping the position?

    **Answer:**

29. What should happen when the tracked wallet:

    - Adds to its position
    - Partially sells
    - Fully exits
    - Transfers tokens elsewhere

    **Answer:**

30. Which exit conditions should be attached automatically after a successful buy?

    **Answer:**

---

## 6. Losing-Trade Diagnosis — 2 minutes

31. Think of a recent avoidable loss. Which warning did you miss, ignore, or misinterpret?

    **Answer:**

32. Was the failure caused by the setup, execution, sizing, or position management?

    **Answer:**

33. What rule could have prevented the loss without filtering out too many good trades?

    **Answer:**

34. What once worked in the trenches but no longer provides an edge?

    **Answer:**

---

## 7. Automation Calibration — 3 minutes

35. Which setups would you trust Termeow to execute without waking you?

    **Answer:**

36. What must always require manual confirmation?

    **Answer:**

37. When data is incomplete, should the agent reject the trade, reduce size, or request approval?

    **Answer:**

38. What should automatically cancel an armed entry?

    **Answer:**

39. What are your non-negotiable limits for the following?

    | Limit | Rule or threshold |
    |---|---|
    | Entry distance from the signal wallet | |
    | Slippage | |
    | Position size | |
    | Liquidity | |
    | Automation lifetime | |
    | Per-trade loss | |
    | Daily loss | |

40. What evidence must appear on the approval screen for you to make a decision in under ten seconds?

    **Answer:**

---

## 8. Rapid-Fire Scenarios — 2 minutes

Answer each with **Buy**, **Wait**, or **Reject**, followed by one sentence.

41. Three tracked wallets buy, but the deployer transfers supply to a fresh wallet.

    **Decision:**
    **Reason:**

42. A trusted KOL posts a contract, but price is already 25% above their entry.

    **Decision:**
    **Reason:**

43. Volume triples while price barely moves and sell activity increases.

    **Decision:**
    **Reason:**

44. Price reclaims the 0.618 level, but one wallet caused most of the move.

    **Decision:**
    **Reason:**

45. The setup is excellent, but estimated round-trip price impact is 18%.

    **Decision:**
    **Reason:**

---

## Interviewer Rules

- Ask for numbers whenever the trader says “high,” “early,” “close,” or “strong.”
- Do not ask for information available from wallet history, RPC data, or platform metadata.
- Ask what would reverse the decision after every important signal.
- Separate information available before entry from hindsight.
- Ask for a real example whenever an answer becomes abstract.
- Record the sequence and timing of checks, not only the final checklist.
- Preserve missing information as unknown rather than treating it as negative.

---

## Skill Extraction Template

Convert every useful pattern into this structure:

### Setup

**Name:**
**Market regime:**
**Applicable launch or venue:**

### Decision Rules

**Required evidence:**
**Entry trigger:**
**Disqualifiers:**
**Position size:**
**Maximum entry distance:**
**Maximum slippage:**
**Invalidation:**
**Profit-taking:**
**Confidence modifiers:**
**Unknown or unavailable inputs:**

### Automation Behavior

**Can execute unattended:** Yes / No
**Requires confirmation when:**
**Cancel the automation when:**
**Conditions activated after a successful buy:**
