/* Demo renderer — uses the standard WebMCP API (document.modelContext). */

const tasks = [
  { id: 1, title: "WebMCP 리서치 정리", done: true },
  { id: 2, title: "webdesktopmcp 라이브러리 구현", done: false },
];

function renderTasks() {
  const list = document.getElementById("tasks");
  list.innerHTML = "";
  for (const task of tasks) {
    const li = document.createElement("li");
    li.innerHTML = `<span>${task.done ? "✅" : "⬜"} ${task.title}</span><code>#${task.id}</code>`;
    list.appendChild(li);
  }
}

const registeredHere = []; // page-local mirror of registered tool names (UI용)

function renderTools() {
  const list = document.getElementById("tools");
  list.innerHTML = "";
  for (const name of registeredHere) {
    const li = document.createElement("li");
    li.innerHTML = `<code>${name}</code>`;
    list.appendChild(li);
  }
}

function registerTool(declaration) {
  registeredHere.push(declaration.name);
  const p = document.modelContext.registerTool(declaration);
  p.then(renderTools).catch((err) => console.error(`[demo] ${declaration.name}:`, err));
  return p;
}

function announce() {
  const mc = document.modelContext;
  if (!mc) return;
  mc.ontoolchange = renderTools;
  renderTools();
}

// -- Imperative tools --------------------------------------------------------

registerTool({
  name: "get-app-info",
  description: "데스크톱 앱의 이름, 버전, 플랫폼, 등록된 도구 수를 반환한다.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true },
  execute: async () => ({
    app: "WebDesktopMCP Demo",
    version: "0.1.0",
    platform: navigator.platform,
    userAgent: navigator.userAgent,
    visible: !document.hidden,
  }),
});

registerTool({
  name: "search-tasks",
  description: "할 일 목록을 검색한다. 빈 쿼리는 전체를 반환한다.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "제목에 포함될 문자열" },
      status: { type: "string", enum: ["all", "done", "open"], description: "상태 필터" },
    },
    required: ["status"],
  },
  annotations: { readOnlyHint: true },
  execute: async ({ query = "", status = "all" }, { signal }) => {
    return tasks
      .filter((t) => (status === "all" ? true : status === "done" ? t.done : !t.done))
      .filter((t) => t.title.toLowerCase().includes(String(query).toLowerCase()))
      .map(({ id, title, done }) => ({ id, title, done }));
  },
});

let nextId = 3;
registerTool({
  name: "create-task",
  description: "새 할 일을 추가한다.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "할 일 제목" },
    },
    required: ["title"],
  },
  execute: async ({ title }) => {
    const task = { id: nextId++, title: String(title), done: false };
    tasks.push(task);
    renderTasks();
    return { created: task };
  },
});

registerTool({
  name: "complete-task",
  description: "할 일을 완료 처리한다.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "완료할 할 일의 ID" },
    },
    required: ["id"],
  },
  execute: async ({ id }) => {
    const task = tasks.find((t) => t.id === Number(id));
    if (!task) throw new Error(`#${id} 할 일을 찾을 수 없습니다.`);
    task.done = true;
    renderTasks();
    return { completed: task };
  },
});

// -- Declarative form tool (index.html의 form[toolname=order-coffee]) --------

const coffeeForm = document.getElementById("coffee");
coffeeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const drink = coffeeForm.elements.namedItem("drink").value;
  const shots = Number(coffeeForm.elements.namedItem("shots").value) || 1;
  const orderNumber = 1000 + Math.floor(Math.random() * 9000);
  const result = { orderNumber, drink, shots, etaMinutes: 3 + shots };
  document.getElementById("order-result").textContent =
    `주문 완료 #${orderNumber} (${drink}, 샷 ${shots})`;
  // The draft's respondWith() pipes a value back to the invoking agent.
  if (typeof event.respondWith === "function") event.respondWith(result);
});

renderTasks();
announce();
