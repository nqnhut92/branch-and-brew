/** The steaming cup of the brewing dialogs; the steam rises while `active`. */
export function BrewingCup({ active }: { active: boolean }) {
  return (
    <svg
      className={`brewing-cup ${active ? 'active' : ''}`}
      viewBox="0 0 48 48"
      width="44"
      height="44"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Animated Steam */}
      <g className="steam-group">
        <path
          className="steam steam-1"
          d="M17 19 C15 14, 19 11, 16 6"
          stroke="var(--vscode-charts-orange, #e08b38)"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          className="steam steam-2"
          d="M23 18 C21 13, 26 10, 23 5"
          stroke="var(--vscode-charts-orange, #e08b38)"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
        <path
          className="steam steam-3"
          d="M29 19 C27 14, 31 11, 28 6"
          stroke="var(--vscode-charts-orange, #e08b38)"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </g>

      {/* Coffee Mug */}
      <path
        d="M12 20 H34 V32 C34 37 30 40 23 40 C16 40 12 37 12 32 Z"
        fill="var(--vscode-button-secondaryBackground, #383838)"
        stroke="var(--vscode-foreground, #cccccc)"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* Coffee surface */}
      <ellipse
        cx="23"
        cy="22"
        rx="9.5"
        ry="2.5"
        fill="var(--vscode-charts-yellow, #d9822b)"
      />
      {/* Handle */}
      <path
        d="M34 23 C39 23 41 26 41 29 C41 33 38 35 34 35"
        stroke="var(--vscode-foreground, #cccccc)"
        strokeWidth="2.5"
        strokeLinecap="round"
        fill="none"
      />
      {/* Saucer */}
      <path
        d="M8 42 C14 44 32 44 38 42"
        stroke="var(--vscode-foreground, #cccccc)"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
