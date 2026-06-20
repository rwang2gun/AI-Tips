const storageKey = "childMealWeightRecords";
const legacyRecipeNoteKey = "childMealRecipeNote";
const recipeStoreKey = "childMealRecipeCards";

const fields = {
  date: document.querySelector("#recordDate"),
  breakfast: document.querySelector("#breakfast"),
  lunch: document.querySelector("#lunch"),
  dinner: document.querySelector("#dinner"),
  snack: document.querySelector("#snack"),
  weight: document.querySelector("#weight"),
  targetWeight: document.querySelector("#targetWeight"),
  exerciseMinutes: document.querySelector("#exerciseMinutes"),
  exercise: document.querySelector("#exercise"),
  goodPoint: document.querySelector("#goodPoint"),
  reflection: document.querySelector("#reflection"),
  tomorrowPlan: document.querySelector("#tomorrowPlan"),
};

const form = document.querySelector("#entryForm");
const formTitle = document.querySelector("#formTitle");
const todayButton = document.querySelector("#todayButton");
const deleteButton = document.querySelector("#deleteButton");
const saveState = document.querySelector("#saveState");
const historyList = document.querySelector("#historyList");
const historyHint = document.querySelector("#historyHint");
const recordCount = document.querySelector("#recordCount");
const latestWeight = document.querySelector("#latestWeight");
const weightDelta = document.querySelector("#weightDelta");
const targetSummary = document.querySelector("#targetSummary");
const remainingWeight = document.querySelector("#remainingWeight");
const emptyChart = document.querySelector("#emptyChart");
const chart = document.querySelector("#weightChart");
const chartContext = chart.getContext("2d");
const recipeTitle = document.querySelector("#recipeTitle");
const recipeLink = document.querySelector("#recipeLink");
const recipeIngredients = document.querySelector("#recipeIngredients");
const recipeContent = document.querySelector("#recipeContent");
const recipeList = document.querySelector("#recipeList");
const newRecipeButton = document.querySelector("#newRecipeButton");
const saveRecipeButton = document.querySelector("#saveRecipeButton");
const deleteRecipeButton = document.querySelector("#deleteRecipeButton");
const recipeState = document.querySelector("#recipeState");

let selectedRecipeId = "";

const todayIso = () => new Date().toISOString().slice(0, 10);

const formatDate = (isoDate) => {
  const date = new Date(`${isoDate}T00:00:00`);
  return new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(date);
};

const formatShortDate = (isoDate) => {
  if (!isoDate) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
  }).format(new Date(isoDate));
};

const readJson = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
};

const readRecords = () => readJson(storageKey, {});

const writeRecords = (records) => {
  localStorage.setItem(storageKey, JSON.stringify(records));
};

const readRecipes = () => readJson(recipeStoreKey, []);

const writeRecipes = (recipes) => {
  localStorage.setItem(recipeStoreKey, JSON.stringify(recipes));
};

const sortedRecords = () =>
  Object.entries(readRecords())
    .map(([date, record]) => ({ date, ...record }))
    .sort((a, b) => a.date.localeCompare(b.date));

const findLatestTargetWeight = (records) => {
  const latest = [...records].reverse().find((record) => Number(record.targetWeight) > 0);
  return latest?.targetWeight || "";
};

const setStatus = (element, message) => {
  element.textContent = message;
  window.clearTimeout(element.statusTimer);
  element.statusTimer = window.setTimeout(() => {
    element.textContent = "";
  }, 2400);
};

const migrateRecipeNotes = () => {
  const existingRecipes = readRecipes();
  if (existingRecipes.length) return;

  const legacyNote = localStorage.getItem(legacyRecipeNoteKey);
  if (legacyNote?.trim()) {
    writeRecipes([
      {
        id: String(Date.now()),
        title: "이전 레시피 메모",
        link: "",
        ingredients: "",
        content: legacyNote.trim(),
        updatedAt: new Date().toISOString(),
      },
    ]);
  }
};

const clearRecipeEditor = () => {
  selectedRecipeId = "";
  recipeTitle.value = "";
  recipeLink.value = "";
  recipeIngredients.value = "";
  recipeContent.value = "";
  renderRecipes();
};

const loadRecipe = (recipeId) => {
  const recipe = readRecipes().find((item) => item.id === recipeId);
  if (!recipe) return;
  selectedRecipeId = recipe.id;
  recipeTitle.value = recipe.title || "";
  recipeLink.value = recipe.link || "";
  recipeIngredients.value = recipe.ingredients || "";
  recipeContent.value = recipe.content || "";
  renderRecipes();
};

const summarizeRecipe = (recipe) => {
  if (recipe.ingredients?.trim()) return `재료: ${recipe.ingredients.trim().slice(0, 42)}`;
  if (recipe.link?.trim()) return "영상/링크 저장됨";
  if (recipe.content?.trim()) return recipe.content.trim().slice(0, 46);
  return "내용 없음";
};

const renderRecipes = () => {
  const recipes = readRecipes().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  recipeList.innerHTML = "";

  if (!recipes.length) {
    const empty = document.createElement("p");
    empty.className = "empty-history";
    empty.textContent = "아직 저장된 레시피가 없습니다.";
    recipeList.append(empty);
    return;
  }

  recipes.forEach((recipe) => {
    const item = document.createElement("button");
    item.className = `recipe-item${recipe.id === selectedRecipeId ? " active" : ""}`;
    item.type = "button";
    item.innerHTML = `
      <time>${formatShortDate(recipe.updatedAt)}</time>
      <strong>${recipe.title}</strong>
      <p>${summarizeRecipe(recipe)}</p>
    `;
    item.addEventListener("click", () => loadRecipe(recipe.id));
    recipeList.append(item);
  });
};

const saveRecipe = () => {
  const title = recipeTitle.value.trim();
  const link = recipeLink.value.trim();
  const ingredients = recipeIngredients.value.trim();
  const content = recipeContent.value.trim();
  if (!title) {
    setStatus(recipeState, "제목을 먼저 적어주세요.");
    return;
  }

  const recipes = readRecipes();
  const existingIndex = recipes.findIndex((recipe) => recipe.id === selectedRecipeId);
  const recipe = {
    id: selectedRecipeId || String(Date.now()),
    title,
    link,
    ingredients,
    content,
    updatedAt: new Date().toISOString(),
  };

  if (existingIndex >= 0) recipes[existingIndex] = recipe;
  else recipes.push(recipe);

  selectedRecipeId = recipe.id;
  writeRecipes(recipes);
  renderRecipes();
  setStatus(recipeState, "레시피를 저장했어요.");
};

const deleteRecipe = () => {
  if (!selectedRecipeId) {
    setStatus(recipeState, "삭제할 레시피를 선택해주세요.");
    return;
  }
  writeRecipes(readRecipes().filter((recipe) => recipe.id !== selectedRecipeId));
  clearRecipeEditor();
  setStatus(recipeState, "레시피를 삭제했어요.");
};

const loadDate = (date) => {
  const records = readRecords();
  const record = records[date] || {};
  const orderedRecords = sortedRecords();

  fields.date.value = date;
  fields.breakfast.value = record.breakfast || "";
  fields.lunch.value = record.lunch || "";
  fields.dinner.value = record.dinner || "";
  fields.snack.value = record.snack || "";
  fields.weight.value = record.weight || "";
  fields.targetWeight.value = record.targetWeight || findLatestTargetWeight(orderedRecords);
  fields.exerciseMinutes.value = record.exerciseMinutes || "";
  fields.exercise.value = record.exercise || "";
  fields.goodPoint.value = record.goodPoint || "";
  fields.reflection.value = record.reflection || "";
  fields.tomorrowPlan.value = record.tomorrowPlan || "";
  formTitle.textContent = date === todayIso() ? "오늘 기록" : `${formatDate(date)} 기록`;
  render();
};

const summarizeMeals = (record) => {
  const filled = ["breakfast", "lunch", "dinner", "snack"].filter((key) => record[key]?.trim()).length;
  if (filled === 0) return "식단 기록 없음";
  return `식단 ${filled}칸 기록`;
};

const summarizeExtras = (record) => {
  const extras = [];
  if (record.exercise?.trim() || Number(record.exerciseMinutes) > 0) {
    extras.push(`운동${Number(record.exerciseMinutes) > 0 ? ` ${record.exerciseMinutes}분` : ""}`);
  }
  if (record.goodPoint?.trim()) extras.push("잘한 점");
  if (record.reflection?.trim()) extras.push("반성");
  if (record.tomorrowPlan?.trim()) extras.push("내일 일정");
  return extras.length ? ` · ${extras.join(" · ")}` : "";
};

const renderHistory = (records) => {
  historyList.innerHTML = "";
  historyHint.textContent = records.length ? "저장된 날짜를 선택해 다시 볼 수 있어요." : "첫 기록을 저장해보세요.";

  if (!records.length) {
    const empty = document.createElement("p");
    empty.className = "empty-history";
    empty.textContent = "아직 저장된 기록이 없습니다.";
    historyList.append(empty);
    return;
  }

  [...records].reverse().forEach((record) => {
    const item = document.createElement("button");
    item.className = `history-item${record.date === fields.date.value ? " active" : ""}`;
    item.type = "button";
    item.innerHTML = `
      <time datetime="${record.date}">${formatDate(record.date)}</time>
      <strong>${record.weight ? `${Number(record.weight).toFixed(1)} kg` : "체중 없음"}</strong>
      <p>${summarizeMeals(record)}${summarizeExtras(record)}</p>
    `;
    item.addEventListener("click", () => loadDate(record.date));
    historyList.append(item);
  });
};

const updateGoalSummary = (weighted) => {
  const latest = weighted.at(-1);
  if (!latest) {
    latestWeight.textContent = "-";
    weightDelta.textContent = "-";
    targetSummary.textContent = "-";
    remainingWeight.textContent = "-";
    return;
  }

  const first = Number(weighted[0].weight);
  const last = Number(latest.weight);
  const target = Number(latest.targetWeight || fields.targetWeight.value);
  latestWeight.textContent = `${last.toFixed(1)} kg`;
  weightDelta.textContent = `${last - first >= 0 ? "+" : ""}${(last - first).toFixed(1)} kg`;

  if (target > 0) {
    const remaining = last - target;
    targetSummary.textContent = `${target.toFixed(1)} kg`;
    remainingWeight.textContent = remaining > 0 ? `${remaining.toFixed(1)} kg` : "목표 도달";
  } else {
    targetSummary.textContent = "-";
    remainingWeight.textContent = "-";
  }
};

const drawChart = (records) => {
  const weighted = records.filter((record) => Number(record.weight) > 0).slice(-14);
  const width = chart.width;
  const height = chart.height;
  chartContext.clearRect(0, 0, width, height);

  emptyChart.hidden = weighted.length > 1;
  recordCount.textContent = `${records.length}일`;
  updateGoalSummary(weighted);

  if (weighted.length < 2) return;

  const padding = { top: 34, right: 24, bottom: 48, left: 48 };
  const values = weighted.map((record) => Number(record.weight));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1);
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const pointFor = (record, index) => {
    const x = padding.left + (plotWidth * index) / (weighted.length - 1);
    const y = padding.top + plotHeight - ((Number(record.weight) - min) / range) * plotHeight;
    return { x, y };
  };

  chartContext.strokeStyle = "#ead9c5";
  chartContext.lineWidth = 1;
  chartContext.fillStyle = "#746a61";
  chartContext.font = "20px Segoe UI, sans-serif";
  chartContext.textAlign = "right";
  chartContext.textBaseline = "middle";

  [min, min + range / 2, max].forEach((value) => {
    const y = padding.top + plotHeight - ((value - min) / range) * plotHeight;
    chartContext.beginPath();
    chartContext.moveTo(padding.left, y);
    chartContext.lineTo(width - padding.right, y);
    chartContext.stroke();
    chartContext.fillText(value.toFixed(1), padding.left - 10, y);
  });

  chartContext.strokeStyle = "#d36b44";
  chartContext.lineWidth = 5;
  chartContext.lineJoin = "round";
  chartContext.lineCap = "round";
  chartContext.beginPath();
  weighted.forEach((record, index) => {
    const point = pointFor(record, index);
    if (index === 0) chartContext.moveTo(point.x, point.y);
    else chartContext.lineTo(point.x, point.y);
  });
  chartContext.stroke();

  weighted.forEach((record, index) => {
    const point = pointFor(record, index);
    chartContext.fillStyle = "#ffffff";
    chartContext.beginPath();
    chartContext.arc(point.x, point.y, 8, 0, Math.PI * 2);
    chartContext.fill();
    chartContext.strokeStyle = "#a94f32";
    chartContext.lineWidth = 3;
    chartContext.stroke();

    if (index === 0 || index === weighted.length - 1) {
      chartContext.fillStyle = "#2d2723";
      chartContext.textAlign = index === 0 ? "left" : "right";
      chartContext.textBaseline = "top";
      chartContext.fillText(record.date.slice(5).replace("-", "."), point.x, height - 34);
    }
  });
};

const render = () => {
  const records = sortedRecords();
  renderHistory(records);
  drawChart(records);
};

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const records = readRecords();
  const date = fields.date.value || todayIso();
  records[date] = {
    breakfast: fields.breakfast.value.trim(),
    lunch: fields.lunch.value.trim(),
    dinner: fields.dinner.value.trim(),
    snack: fields.snack.value.trim(),
    weight: fields.weight.value,
    targetWeight: fields.targetWeight.value,
    exerciseMinutes: fields.exerciseMinutes.value,
    exercise: fields.exercise.value.trim(),
    goodPoint: fields.goodPoint.value.trim(),
    reflection: fields.reflection.value.trim(),
    tomorrowPlan: fields.tomorrowPlan.value.trim(),
  };
  writeRecords(records);
  loadDate(date);
  setStatus(saveState, "저장했어요.");
});

fields.date.addEventListener("change", () => loadDate(fields.date.value || todayIso()));
fields.targetWeight.addEventListener("input", () => render());
todayButton.addEventListener("click", () => loadDate(todayIso()));

deleteButton.addEventListener("click", () => {
  const records = readRecords();
  const date = fields.date.value;
  if (!records[date]) {
    setStatus(saveState, "삭제할 기록이 없어요.");
    return;
  }
  delete records[date];
  writeRecords(records);
  loadDate(date);
  setStatus(saveState, "기록을 삭제했어요.");
});

newRecipeButton.addEventListener("click", clearRecipeEditor);
saveRecipeButton.addEventListener("click", saveRecipe);
deleteRecipeButton.addEventListener("click", deleteRecipe);
window.addEventListener("resize", () => render());

migrateRecipeNotes();
renderRecipes();
loadDate(todayIso());
