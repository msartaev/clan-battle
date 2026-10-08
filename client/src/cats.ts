/**
 * Коты по бокам экрана в конце боя (идея Даниэля): при победе держат золотой кубок и улыбаются,
 * при поражении — держат перевёрнутый золотой кубок, а на нём стоит серебряный.
 */

function cup(x: number, y: number, s: number, fill: string, dark: string, flip: boolean): string {
  // Кубок нарисован вокруг (0,0): чаша сверху, ножка и подставка снизу
  const t = `translate(${x} ${y}) scale(${s}) ${flip ? "rotate(180)" : ""}`;
  return `<g transform="${t}">
    <path d="M-24 -30 H24 Q24 6 0 10 Q-24 6 -24 -30 Z" fill="${fill}" stroke="${dark}" stroke-width="2.5"/>
    <path d="M-24 -24 Q-38 -24 -36 -10 Q-34 0 -18 2" fill="none" stroke="${dark}" stroke-width="4"/>
    <path d="M24 -24 Q38 -24 36 -10 Q34 0 18 2" fill="none" stroke="${dark}" stroke-width="4"/>
    <rect x="-4" y="9" width="8" height="12" fill="${fill}" stroke="${dark}" stroke-width="2"/>
    <rect x="-16" y="20" width="32" height="8" rx="2" fill="${fill}" stroke="${dark}" stroke-width="2.5"/>
    <path d="M-14 -24 Q-12 -6 -4 2" fill="none" stroke="#fff" stroke-opacity="0.55" stroke-width="3"/>
  </g>`;
}

export function catSvg(win: boolean): string {
  const fur = "#f0a24a";
  const furDark = "#b8661f";
  const mouth = win
    ? `<path d="M88 132 Q100 146 112 132" fill="none" stroke="#3a2412" stroke-width="3.5" stroke-linecap="round"/>`
    : `<path d="M88 140 Q100 130 112 140" fill="none" stroke="#3a2412" stroke-width="3.5" stroke-linecap="round"/>`;
  const eyes = win
    ? `<path d="M76 112 Q83 104 90 112" fill="none" stroke="#3a2412" stroke-width="4" stroke-linecap="round"/>
       <path d="M110 112 Q117 104 124 112" fill="none" stroke="#3a2412" stroke-width="4" stroke-linecap="round"/>`
    : `<ellipse cx="83" cy="112" rx="5" ry="7" fill="#3a2412"/><ellipse cx="117" cy="112" rx="5" ry="7" fill="#3a2412"/>
       <path d="M74 100 L90 104 M126 100 L110 104" stroke="#3a2412" stroke-width="3" stroke-linecap="round"/>`;
  const trophy = win
    ? cup(100, 38, 1.1, "#ffd23f", "#a8780a", false)
    : cup(100, 34, 1.0, "#ffd23f", "#a8780a", true) + cup(100, -10, 0.7, "#d9dee4", "#7d8792", false);
  return `<svg viewBox="0 -40 200 320" xmlns="http://www.w3.org/2000/svg">
    <path d="M150 250 Q196 236 186 196 Q180 176 168 186" fill="none" stroke="${furDark}" stroke-width="12" stroke-linecap="round"/>
    <ellipse cx="100" cy="220" rx="52" ry="50" fill="${fur}" stroke="${furDark}" stroke-width="3"/>
    <ellipse cx="100" cy="230" rx="30" ry="32" fill="#fbe3c4"/>
    <path d="M62 196 Q46 140 66 66" fill="none" stroke="${fur}" stroke-width="16" stroke-linecap="round"/>
    <path d="M138 196 Q154 140 134 66" fill="none" stroke="${fur}" stroke-width="16" stroke-linecap="round"/>
    <circle cx="100" cy="122" r="44" fill="${fur}" stroke="${furDark}" stroke-width="3"/>
    <path d="M62 102 L66 66 L90 84 Z" fill="${fur}" stroke="${furDark}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M138 102 L134 66 L110 84 Z" fill="${fur}" stroke="${furDark}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M69 94 L70 76 L83 86 Z M131 94 L130 76 L117 86 Z" fill="#f7b6b0"/>
    <path d="M84 96 L90 90 M100 92 L100 84 M116 96 L110 90" stroke="${furDark}" stroke-width="3" stroke-linecap="round"/>
    ${eyes}
    <path d="M95 122 L105 122 L100 128 Z" fill="#e0707a"/>
    ${mouth}
    <path d="M56 124 L80 126 M56 134 L80 130 M144 124 L120 126 M144 134 L120 130" stroke="#3a2412" stroke-width="1.6" stroke-linecap="round"/>
    ${trophy}
    <circle cx="66" cy="66" r="10" fill="${fur}" stroke="${furDark}" stroke-width="2.5"/>
    <circle cx="134" cy="66" r="10" fill="${fur}" stroke="${furDark}" stroke-width="2.5"/>
  </svg>`;
}

/** Показать котов по бокам экрана конца боя (null — убрать) */
export function showCats(win: boolean | null): void {
  for (const side of ["left", "right"] as const) {
    let el = document.getElementById(`cat-${side}`);
    if (!el) {
      el = document.createElement("div");
      el.id = `cat-${side}`;
      el.className = `end-cat ${side}`;
      document.getElementById("over")!.appendChild(el);
    }
    el.innerHTML = win === null ? "" : catSvg(win);
    el.classList.toggle("lose", win === false);
  }
}
