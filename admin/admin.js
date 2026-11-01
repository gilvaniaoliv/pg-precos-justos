/**
 * ============================================================================
 * LÓGICA DO PAINEL ADMINISTRATIVO (/admin) - P&G PREÇOS JUSTOS
 * ============================================================================
 * Recursos incluídos:
 * - Autenticação via Supabase (e-mail e senha, sem cadastro público)
 * - Expiração automática de sessão por inatividade
 * - Dashboard: Vendas do mês, Margem estimada, Estoque baixo (<3), Pesquisa (>60d)
 * - CRUD completo de produtos + Upload de foto para o Supabase Storage
 * - Botões rápidos + e - para ajustar estoque
 * - Registro de venda com alerta obrigatório se abaixo do preço mínimo
 * - Validação de dados e proteção contra XSS (textContent / createElement)
 */

(function () {
  "use strict";

  const CFG = window.LOJA_CONFIG || {};
  let supabaseClient = null;

  const estado = {
    modoDemo: false,
    usuario: null,
    categorias: [],
    produtos: [],
    vendasMes: [],
    busca: "",
    categoriaFiltro: "todas",
    chipFiltro: "todos", // todos | ativos | inativos | estoque_baixo | pesquisa_vencida
    produtoEmVenda: null
  };

  // Controle de expiração por inatividade
  let timerInatividade = null;
  const TEMPO_INATIVIDADE_MS =
    (Number(CFG.TEMPO_INATIVIDADE_ADMIN_MINUTOS) || 30) * 60 * 1000;

  // ==========================================================================
  // 1. UTILITÁRIOS DE FORMATAÇÃO, DATAS E SANITIZAÇÃO
  // ==========================================================================

  function formatarMoeda(valor) {
    const num = Number(valor) || 0;
    return num.toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL"
    });
  }

  function limparTexto(texto, tamanhoMax = 500) {
    return String(texto || "")
      .replace(/[\u0000-\u001F\u007F]/g, "")
      .trim()
      .slice(0, tamanhoMax);
  }

  function gerarSlug(nome) {
    return String(nome || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function hojeISO() {
    const d = new Date();
    const ano = d.getFullYear();
    const mes = String(d.getMonth() + 1).padStart(2, "0");
    const dia = String(d.getDate()).padStart(2, "0");
    return `${ano}-${mes}-${dia}`;
  }

  function diasDesdePesquisa(dataIso) {
    if (!dataIso) return Infinity;
    const partes = String(dataIso).split("T")[0].split("-");
    if (partes.length !== 3) return Infinity;
    const dataPesquisa = new Date(
      parseInt(partes[0], 10),
      parseInt(partes[1], 10) - 1,
      parseInt(partes[2], 10),
      12,
      0,
      0
    );
    if (isNaN(dataPesquisa.getTime())) return Infinity;

    const agora = new Date();
    const hoje = new Date(
      agora.getFullYear(),
      agora.getMonth(),
      agora.getDate(),
      12,
      0,
      0
    );
    return Math.floor((hoje.getTime() - dataPesquisa.getTime()) / (1000 * 60 * 60 * 24));
  }

  function pesquisaEstaVencida(produto) {
    const limite = Number(CFG.DIAS_VALIDADE_PESQUISA) || 60;
    if (!produto.data_pesquisa) return true;
    return diasDesdePesquisa(produto.data_pesquisa) > limite;
  }

  function obterFotoPlaceholder() {
    return (
      "data:image/svg+xml;charset=UTF-8," +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
          <rect width="200" height="200" fill="#e6f4ee"/>
          <text x="50%" y="52%" dominant-baseline="middle" text-anchor="middle" fill="#0f3d2e" font-family="sans-serif" font-size="18" font-weight="bold">P&amp;G</text>
        </svg>`
      )
    );
  }

  let timerToast = null;
  function mostrarToast(msg) {
    const el = document.getElementById("toastAdmin");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("visivel");
    if (timerToast) clearTimeout(timerToast);
    timerToast = setTimeout(() => el.classList.remove("visivel"), 2800);
  }

  // ==========================================================================
  // 2. INICIALIZAÇÃO DO SUPABASE, AUTH E EXPIRAÇÃO POR INATIVIDADE
  // ==========================================================================

  function supabaseConfigurado() {
    return (
      CFG.SUPABASE_URL &&
      CFG.SUPABASE_ANON_KEY &&
      !CFG.SUPABASE_URL.includes("SEU-PROJETO") &&
      !CFG.SUPABASE_ANON_KEY.includes("COLE_AQUI")
    );
  }

  function reiniciarTimerInatividade() {
    if (!estado.usuario) return;
    if (timerInatividade) clearTimeout(timerInatividade);
    timerInatividade = setTimeout(() => {
      encerrarSessaoPorInatividade();
    }, TEMPO_INATIVIDADE_MS);
  }

  function iniciarMonitoramentoInatividade() {
    const eventos = ["click", "keydown", "mousemove", "touchstart", "scroll"];
    eventos.forEach((ev) => {
      window.addEventListener(ev, reiniciarTimerInatividade, { passive: true });
    });
    reiniciarTimerInatividade();
  }

  async function encerrarSessaoPorInatividade() {
    if (supabaseClient && !estado.modoDemo) {
      await supabaseClient.auth.signOut();
    }
    estado.usuario = null;
    exibirTelaLogin("Sua sessão expirou por inatividade. Faça login novamente.");
  }

  function exibirTelaLogin(mensagemErro = "") {
    const telaLogin = document.getElementById("telaLogin");
    const painel = document.getElementById("painelAdminConteudo");
    const alerta = document.getElementById("alertaLogin");

    if (painel) painel.style.display = "none";
    if (telaLogin) telaLogin.style.display = "flex";

    if (alerta) {
      if (mensagemErro) {
        alerta.textContent = mensagemErro;
        alerta.style.display = "block";
      } else {
        alerta.style.display = "none";
      }
    }
  }

  async function exibirPainelAutenticado(usuario) {
    estado.usuario = usuario;
    const telaLogin = document.getElementById("telaLogin");
    const painel = document.getElementById("painelAdminConteudo");
    const infoUsuario = document.getElementById("infoUsuarioLogado");

    if (telaLogin) telaLogin.style.display = "none";
    if (painel) painel.style.display = "block";
    if (infoUsuario) {
      infoUsuario.textContent = estado.modoDemo
        ? "Modo Demonstração (Local)"
        : usuario.email || "Administrador";
    }

    iniciarMonitoramentoInatividade();
    await carregarDadosAdmin();
  }

  // ==========================================================================
  // 3. CARREGAMENTO DE DADOS (SUPABASE OU DEMONSTRAÇÃO)
  // ==========================================================================

  function carregarDadosDemoInicial() {
    const d10 = new Date();
    d10.setDate(d10.getDate() - 10);
    const dataRecente = d10.toISOString().split("T")[0];

    const d75 = new Date();
    d75.setDate(d75.getDate() - 75);
    const dataAntiga = d75.toISOString().split("T")[0];

    estado.categorias = [
      { id: "cat-casa", nome: "Casa e Cozinha", slug: "casa-e-cozinha", ordem: 1 },
      { id: "cat-eletro", nome: "Eletrônicos e Acessórios", slug: "eletronicos-e-acessorios", ordem: 2 },
      { id: "cat-cuidados", nome: "Cuidados Pessoais", slug: "cuidados-pessoais", ordem: 3 }
    ];

    estado.produtos = [
      {
        id: "demo-1",
        nome: "Garrafa Térmica Inox 1 Litro com Visor LED",
        descricao: "Conserva líquidos quentes ou gelados por até 12 horas.",
        categoria_id: "cat-casa",
        foto_url: "https://images.unsplash.com/photo-1602143407151-7111542de6e8?auto=format&fit=crop&w=700&q=80",
        preco_venda: 59.9,
        preco_medio_mercado: 79.9,
        data_pesquisa: dataRecente,
        fontes_pesquisa: "Mercado Livre R$ 78,90 / Amazon R$ 81,00",
        preco_minimo_negociacao: 52.0,
        preco_custo: 34.5,
        estoque: 6,
        destaque: true,
        ativo: true
      },
      {
        id: "demo-2",
        nome: "Fone de Ouvido Bluetooth 5.3 TWS com Case",
        descricao: "Som nítido, microfone embutido e estojo carregador.",
        categoria_id: "cat-eletro",
        foto_url: "https://images.unsplash.com/photo-1590658268037-6bf12165a8df?auto=format&fit=crop&w=700&q=80",
        preco_venda: 69.9,
        preco_medio_mercado: 89.9,
        data_pesquisa: dataRecente,
        fontes_pesquisa: "Shopee Oficial R$ 88,00 / Magazine R$ 92,00",
        preco_minimo_negociacao: 60.0,
        preco_custo: 39.0,
        estoque: 2, // Estoque baixo (< 3)
        destaque: true,
        ativo: true
      },
      {
        id: "demo-3",
        nome: "Jogo de Chaves de Precisão 31 Peças",
        descricao: "Pontas imantadas para manutenção de aparelhos.",
        categoria_id: "cat-casa",
        foto_url: "https://images.unsplash.com/photo-1581147036324-c1c9bf853b64?auto=format&fit=crop&w=700&q=80",
        preco_venda: 34.9,
        preco_medio_mercado: 44.9,
        data_pesquisa: dataAntiga, // > 60 dias (alerta para atualizar)
        fontes_pesquisa: "Loja Ferragens Centro R$ 45,00",
        preco_minimo_negociacao: 30.0,
        preco_custo: 18.0,
        estoque: 5,
        destaque: false,
        ativo: true
      }
    ];

    estado.vendasMes = [
      {
        id: "v-1",
        produto_id: "demo-1",
        nome_produto_snapshot: "Garrafa Térmica Inox 1 Litro com Visor LED",
        quantidade: 2,
        valor_unitario: 59.9,
        valor_total: 119.8,
        custo_unitario_snapshot: 34.5,
        data_venda: new Date().toISOString()
      }
    ];
  }

  async function carregarDadosAdmin() {
    if (estado.modoDemo) {
      if (estado.produtos.length === 0) carregarDadosDemoInicial();
      atualizarSelectsCategorias();
      atualizarResumoDashboard();
      renderizarListaProdutos();
      return;
    }

    try {
      const inicioMes = new Date();
      inicioMes.setDate(1);
      inicioMes.setHours(0, 0, 0, 0);

      const [resCat, resProd, resVendas] = await Promise.all([
        supabaseClient
          .from("categorias")
          .select("*")
          .order("ordem", { ascending: true })
          .order("nome", { ascending: true }),
        supabaseClient
          .from("produtos")
          .select("*")
          .order("criado_em", { ascending: false }),
        supabaseClient
          .from("vendas")
          .select("*")
          .gte("data_venda", inicioMes.toISOString())
          .order("data_venda", { ascending: false })
      ]);

      if (resCat.error) throw resCat.error;
      if (resProd.error) throw resProd.error;
      if (resVendas.error) throw resVendas.error;

      estado.categorias = resCat.data || [];
      estado.produtos = resProd.data || [];
      estado.vendasMes = resVendas.data || [];

      atualizarSelectsCategorias();
      atualizarResumoDashboard();
      renderizarListaProdutos();
    } catch (erro) {
      console.error("Erro ao carregar dados do painel:", erro);
      mostrarToast("Erro ao carregar dados do banco.");
    }
  }

  // ==========================================================================
  // 4. RESUMO SIMPLES (VENDAS DO MÊS, MARGEM, ESTOQUE BAIXO, PESQUISA > 60 DIAS)
  // ==========================================================================

  function atualizarResumoDashboard() {
    const limiteEstoqueBaixo = Number(CFG.LIMITE_ESTOQUE_BAIXO) || 3;

    // 1. Vendas do mês e lucro realizado no mês
    let receitaMes = 0;
    let custoVendasMes = 0;
    let qtdPedidosMes = estado.vendasMes.length;

    estado.vendasMes.forEach((v) => {
      const totalVenda = Number(v.valor_total) || 0;
      const custoTotal = (Number(v.custo_unitario_snapshot) || 0) * (Number(v.quantidade) || 1);
      receitaMes += totalVenda;
      custoVendasMes += custoTotal;
    });

    const lucroMes = receitaMes - custoVendasMes;

    // 2. Margem de lucro estimada (média ponderada do catálogo ativo ou vendas)
    let somaVendaCatalogo = 0;
    let somaLucroCatalogo = 0;

    estado.produtos.forEach((p) => {
      if (p.ativo && Number(p.preco_venda) > 0) {
        const venda = Number(p.preco_venda);
        const custo = Number(p.preco_custo) || 0;
        somaVendaCatalogo += venda;
        somaLucroCatalogo += venda - custo;
      }
    });

    const margemCatalogoPct =
      somaVendaCatalogo > 0 ? Math.round((somaLucroCatalogo / somaVendaCatalogo) * 100) : 0;

    // 3. Produtos com estoque baixo (< 3)
    const qtdEstoqueBaixo = estado.produtos.filter(
      (p) => p.ativo && Number(p.estoque) < limiteEstoqueBaixo
    ).length;

    // 4. Produtos com pesquisa de preço > 60 dias
    const qtdPesquisaVencida = estado.produtos.filter(
      (p) => p.ativo && pesquisaEstaVencida(p)
    ).length;

    // Atualiza DOM
    const elVendasValor = document.getElementById("resumoVendasMesValor");
    const elVendasQtd = document.getElementById("resumoVendasMesQtd");
    const elMargem = document.getElementById("resumoMargemMedia");
    const elLucroMes = document.getElementById("resumoLucroMes");
    const elEstoqueBaixo = document.getElementById("resumoEstoqueBaixoQtd");
    const elPesquisaAntiga = document.getElementById("resumoPesquisaAntigaQtd");

    if (elVendasValor) elVendasValor.textContent = formatarMoeda(receitaMes);
    if (elVendasQtd) {
      elVendasQtd.textContent = `${qtdPedidosMes} ${qtdPedidosMes === 1 ? "venda registrada" : "vendas registradas"
        }`;
    }
    if (elMargem) elMargem.textContent = `${margemCatalogoPct}%`;
    if (elLucroMes) elLucroMes.textContent = `Lucro no mês: ${formatarMoeda(lucroMes)}`;

    if (elEstoqueBaixo) {
      elEstoqueBaixo.textContent = String(qtdEstoqueBaixo);
      elEstoqueBaixo.classList.toggle("alerta", qtdEstoqueBaixo > 0);
    }

    if (elPesquisaAntiga) {
      elPesquisaAntiga.textContent = String(qtdPesquisaVencida);
      elPesquisaAntiga.classList.toggle("alerta", qtdPesquisaVencida > 0);
    }
  }

  // ==========================================================================
  // 5. RENDERIZAÇÃO DA LISTA DE PRODUTOS E FILTROS
  // ==========================================================================

  function atualizarSelectsCategorias() {
    const selectFiltro = document.getElementById("selectCategoriaAdmin");
    const selectForm = document.getElementById("prodCategoria");

    if (selectFiltro) {
      const valorAtual = selectFiltro.value || "todas";
      selectFiltro.textContent = "";
      const optTodas = document.createElement("option");
      optTodas.value = "todas";
      optTodas.textContent = "Todas as categorias";
      selectFiltro.appendChild(optTodas);

      estado.categorias.forEach((c) => {
        const opt = document.createElement("option");
        opt.value = String(c.id);
        opt.textContent = c.nome;
        selectFiltro.appendChild(opt);
      });
      selectFiltro.value = valorAtual;
    }

    if (selectForm) {
      const valorAtualForm = selectForm.value || "";
      selectForm.textContent = "";
      const optSem = document.createElement("option");
      optSem.value = "";
      optSem.textContent = "Sem categoria";
      selectForm.appendChild(optSem);

      estado.categorias.forEach((c) => {
        const opt = document.createElement("option");
        opt.value = String(c.id);
        opt.textContent = c.nome;
        selectForm.appendChild(opt);
      });
      selectForm.value = valorAtualForm;
    }
  }

  function obterNomeCategoria(categoriaId) {
    const cat = estado.categorias.find((c) => String(c.id) === String(categoriaId));
    return cat ? cat.nome : "Sem categoria";
  }

  function renderizarListaProdutos() {
    const container = document.getElementById("listaAdminProdutos");
    const contagem = document.getElementById("contagemAdminProdutos");
    if (!container) return;

    const limiteBaixo = Number(CFG.LIMITE_ESTOQUE_BAIXO) || 3;
    const termo = estado.busca.trim().toLowerCase();

    const filtrados = estado.produtos.filter((p) => {
      if (
        estado.categoriaFiltro !== "todas" &&
        String(p.categoria_id) !== estado.categoriaFiltro
      ) {
        return false;
      }

      if (termo && !String(p.nome || "").toLowerCase().includes(termo)) {
        return false;
      }

      if (estado.chipFiltro === "ativos" && !p.ativo) return false;
      if (estado.chipFiltro === "inativos" && p.ativo) return false;
      if (estado.chipFiltro === "estoque_baixo" && Number(p.estoque) >= limiteBaixo) {
        return false;
      }
      if (estado.chipFiltro === "pesquisa_vencida" && !pesquisaEstaVencida(p)) {
        return false;
      }

      return true;
    });

    if (contagem) {
      contagem.textContent = `${filtrados.length} ${filtrados.length === 1 ? "produto" : "produtos"
        }`;
    }

    container.textContent = "";

    if (filtrados.length === 0) {
      const vazio = document.createElement("div");
      vazio.className = "estado-lista";
      vazio.style.gridColumn = "1 / -1";
      vazio.textContent = "Nenhum produto encontrado para os filtros selecionados.";
      container.appendChild(vazio);
      return;
    }

    filtrados.forEach((p) => {
      container.appendChild(criarCardAdminProduto(p));
    });
  }

  function criarCardAdminProduto(produto) {
    const limiteBaixo = Number(CFG.LIMITE_ESTOQUE_BAIXO) || 3;
    const card = document.createElement("article");
    card.className = "admin-produto-card" + (!produto.ativo ? " inativo" : "");

    // Topo com foto, badges e título
    const topo = document.createElement("div");
    topo.className = "admin-produto-topo";

    const img = document.createElement("img");
    img.className = "admin-produto-foto";
    img.src =
      produto.foto_url && /^https?:\/\//i.test(produto.foto_url)
        ? produto.foto_url
        : obterFotoPlaceholder();
    img.alt = produto.nome;
    img.loading = "lazy";
    img.addEventListener("error", () => {
      img.src = obterFotoPlaceholder();
    });

    const cabecalho = document.createElement("div");
    cabecalho.className = "admin-produto-cabecalho";

    const badges = document.createElement("div");
    badges.className = "admin-produto-badges";

    const bStatus = document.createElement("span");
    bStatus.className = "badge-admin " + (produto.ativo ? "badge-ativo" : "badge-inativo");
    bStatus.textContent = produto.ativo ? "Ativo" : "Inativo";
    badges.appendChild(bStatus);

    if (produto.destaque) {
      const bDest = document.createElement("span");
      bDest.className = "badge-admin badge-amarelo";
      bDest.textContent = "⭐ Destaque";
      badges.appendChild(bDest);
    }

    if (Number(produto.estoque) === 0) {
      const bZero = document.createElement("span");
      bZero.className = "badge-admin badge-alerta";
      bZero.textContent = "Esgotado (0)";
      badges.appendChild(bZero);
    } else if (Number(produto.estoque) < limiteBaixo) {
      const bBaixo = document.createElement("span");
      bBaixo.className = "badge-admin badge-alerta";
      bBaixo.textContent = "Estoque Baixo";
      badges.appendChild(bBaixo);
    }

    if (pesquisaEstaVencida(produto)) {
      const bPesq = document.createElement("span");
      bPesq.className = "badge-admin badge-amarelo";
      bPesq.textContent = "🕒 Pesquisa > 60 dias";
      badges.appendChild(bPesq);
    }

    const h3 = document.createElement("h3");
    h3.className = "admin-produto-nome";
    h3.textContent = produto.nome;

    const cat = document.createElement("div");
    cat.className = "admin-produto-categoria";
    cat.textContent = obterNomeCategoria(produto.categoria_id);

    cabecalho.appendChild(badges);
    cabecalho.appendChild(h3);
    cabecalho.appendChild(cat);

    topo.appendChild(img);
    topo.appendChild(cabecalho);
    card.appendChild(topo);

    // Métricas internas (Venda, Custo, Mínimo e Lucro unitário)
    const metricas = document.createElement("div");
    metricas.className = "admin-metricas-internas";

    const venda = Number(produto.preco_venda) || 0;
    const custo = Number(produto.preco_custo) || 0;
    const minimo = Number(produto.preco_minimo_negociacao) || 0;
    const lucroUnit = venda - custo;
    const margemPct = venda > 0 ? Math.round((lucroUnit / venda) * 100) : 0;

    const itensMetrica = [
      { rotulo: "Preço de Venda", valor: formatarMoeda(venda) },
      { rotulo: "Preço Mínimo (Admin)", valor: formatarMoeda(minimo) },
      { rotulo: "Custo (Admin)", valor: formatarMoeda(custo) },
      { rotulo: "Lucro / Margem", valor: `${formatarMoeda(lucroUnit)} (${margemPct}%)` }
    ];

    itensMetrica.forEach((m) => {
      const divM = document.createElement("div");
      divM.className = "metrica-item";
      const sp = document.createElement("span");
      sp.textContent = m.rotulo;
      const st = document.createElement("strong");
      st.textContent = m.valor;
      divM.appendChild(sp);
      divM.appendChild(st);
      metricas.appendChild(divM);
    });

    card.appendChild(metricas);

    // Barra de ajuste rápido de estoque (+ e -)
    const barraEstoque = document.createElement("div");
    barraEstoque.className = "admin-estoque-barra";

    const rotuloEstoque = document.createElement("span");
    rotuloEstoque.className = "estoque-rotulo-atual";
    const qtdEstoqueNum = Number(produto.estoque) || 0;
    rotuloEstoque.textContent = `Estoque: ${qtdEstoqueNum} ${
      qtdEstoqueNum === 1 ? "unidade" : "unidades"
    }`;

    const botoesEstoque = document.createElement("div");
    botoesEstoque.className = "estoque-botoes-rapidos";

    const btnMenos = document.createElement("button");
    btnMenos.type = "button";
    btnMenos.className = "btn-estoque-rapido";
    btnMenos.textContent = "−";
    btnMenos.title = "Diminuir 1 unidade do estoque";
    btnMenos.disabled = Number(produto.estoque) <= 0;
    btnMenos.addEventListener("click", () => ajustarEstoqueRapido(produto, -1));

    const btnMais = document.createElement("button");
    btnMais.type = "button";
    btnMais.className = "btn-estoque-rapido";
    btnMais.textContent = "+";
    btnMais.title = "Adicionar 1 unidade ao estoque";
    btnMais.addEventListener("click", () => ajustarEstoqueRapido(produto, 1));

    botoesEstoque.appendChild(btnMenos);
    botoesEstoque.appendChild(btnMais);

    barraEstoque.appendChild(rotuloEstoque);
    barraEstoque.appendChild(botoesEstoque);
    card.appendChild(barraEstoque);

    // Botões de ação: Registrar venda, Editar e Ativar/Desativar
    const acoes = document.createElement("div");
    acoes.className = "admin-card-acoes";

    const btnVenda = document.createElement("button");
    btnVenda.type = "button";
    btnVenda.className = "btn-registrar-venda";
    btnVenda.disabled = Number(produto.estoque) <= 0;
    btnVenda.textContent =
      Number(produto.estoque) > 0 ? "💸 Registrar Venda" : "Sem Estoque para Venda";
    btnVenda.addEventListener("click", () => abrirModalVenda(produto));

    const btnEditar = document.createElement("button");
    btnEditar.type = "button";
    btnEditar.className = "btn-secundario-admin";
    btnEditar.textContent = "✏️ Editar";
    btnEditar.addEventListener("click", () => abrirModalProduto(produto));

    const btnAlternarAtivo = document.createElement("button");
    btnAlternarAtivo.type = "button";
    btnAlternarAtivo.className = "btn-secundario-admin";
    btnAlternarAtivo.textContent = produto.ativo ? "🙈 Ocultar" : "👁️ Ativar";
    btnAlternarAtivo.addEventListener("click", () => alternarAtivoRapido(produto));

    acoes.appendChild(btnVenda);
    acoes.appendChild(btnEditar);
    acoes.appendChild(btnAlternarAtivo);
    card.appendChild(acoes);

    return card;
  }

  // ==========================================================================
  // 6. AJUSTE RÁPIDO DE ESTOQUE (+ / -) E ATIVO/INATIVO
  // ==========================================================================

  async function ajustarEstoqueRapido(produto, delta) {
    const novoEstoque = Math.max(0, (parseInt(produto.estoque, 10) || 0) + delta);

    if (estado.modoDemo) {
      produto.estoque = novoEstoque;
      atualizarResumoDashboard();
      renderizarListaProdutos();
      mostrarToast(`Estoque de "${produto.nome}" atualizado para ${novoEstoque} un.`);
      return;
    }

    try {
      const { error } = await supabaseClient
        .from("produtos")
        .update({ estoque: novoEstoque })
        .eq("id", produto.id);

      if (error) throw error;
      produto.estoque = novoEstoque;
      atualizarResumoDashboard();
      renderizarListaProdutos();
      mostrarToast(
        `Estoque atualizado: ${novoEstoque} ${novoEstoque === 1 ? "unidade" : "unidades"}.`
      );
    } catch (erro) {
      console.error("Erro ao ajustar estoque:", erro);
      mostrarToast("Não foi possível atualizar o estoque.");
    }
  }

  async function alternarAtivoRapido(produto) {
    const novoAtivo = !produto.ativo;

    if (estado.modoDemo) {
      produto.ativo = novoAtivo;
      atualizarResumoDashboard();
      renderizarListaProdutos();
      mostrarToast(novoAtivo ? "Produto ativado na vitrine." : "Produto ocultado da vitrine.");
      return;
    }

    try {
      const { error } = await supabaseClient
        .from("produtos")
        .update({ ativo: novoAtivo })
        .eq("id", produto.id);

      if (error) throw error;
      produto.ativo = novoAtivo;
      atualizarResumoDashboard();
      renderizarListaProdutos();
      mostrarToast(novoAtivo ? "Produto ativado na vitrine." : "Produto ocultado da vitrine.");
    } catch (erro) {
      console.error("Erro ao alterar status do produto:", erro);
      mostrarToast("Erro ao alterar visibilidade do produto.");
    }
  }

  // ==========================================================================
  // 7. MODAL ADICIONAR / EDITAR PRODUTO + UPLOAD DE FOTO NO STORAGE
  // ==========================================================================

  function abrirModalProduto(produto = null) {
    const modal = document.getElementById("modalProduto");
    const titulo = document.getElementById("tituloModalProduto");
    const alerta = document.getElementById("alertaFormProduto");
    const btnExcluir = document.getElementById("btnExcluirProdutoModal");
    const inputArquivo = document.getElementById("prodArquivoFoto");

    if (alerta) alerta.style.display = "none";
    if (inputArquivo) inputArquivo.value = "";

    atualizarSelectsCategorias();

    if (produto) {
      if (titulo) titulo.textContent = "✏️ Editar Produto";
      document.getElementById("produtoIdInput").value = produto.id;
      document.getElementById("prodNome").value = produto.nome || "";
      document.getElementById("prodCategoria").value = produto.categoria_id || "";
      document.getElementById("prodEstoque").value = Number(produto.estoque) || 0;
      document.getElementById("prodDescricao").value = produto.descricao || "";
      document.getElementById("prodFotoUrl").value = produto.foto_url || "";
      document.getElementById("previewFotoProduto").src =
        produto.foto_url || obterFotoPlaceholder();
      document.getElementById("prodPrecoVenda").value = produto.preco_venda ?? "";
      document.getElementById("prodPrecoMedio").value =
        produto.preco_medio_mercado ?? "";
      document.getElementById("prodDataPesquisa").value =
        produto.data_pesquisa ? String(produto.data_pesquisa).split("T")[0] : "";
      document.getElementById("prodPrecoCusto").value = produto.preco_custo ?? 0;
      document.getElementById("prodPrecoMinimo").value =
        produto.preco_minimo_negociacao ?? 0;
      document.getElementById("prodFontesPesquisa").value =
        produto.fontes_pesquisa || "";
      document.getElementById("prodAtivo").checked = Boolean(produto.ativo);
      document.getElementById("prodDestaque").checked = Boolean(produto.destaque);
      if (btnExcluir) btnExcluir.style.display = "inline-flex";
    } else {
      if (titulo) titulo.textContent = "➕ Adicionar Novo Produto";
      document.getElementById("produtoIdInput").value = "";
      document.getElementById("prodNome").value = "";
      document.getElementById("prodCategoria").value =
        estado.categorias[0] ? String(estado.categorias[0].id) : "";
      document.getElementById("prodEstoque").value = 1;
      document.getElementById("prodDescricao").value = "";
      document.getElementById("prodFotoUrl").value = "";
      document.getElementById("previewFotoProduto").src = obterFotoPlaceholder();
      document.getElementById("prodPrecoVenda").value = "";
      document.getElementById("prodPrecoMedio").value = "";
      document.getElementById("prodDataPesquisa").value = hojeISO();
      document.getElementById("prodPrecoCusto").value = "";
      document.getElementById("prodPrecoMinimo").value = "";
      document.getElementById("prodFontesPesquisa").value = "";
      document.getElementById("prodAtivo").checked = true;
      document.getElementById("prodDestaque").checked = false;
      if (btnExcluir) btnExcluir.style.display = "none";
    }

    if (modal) {
      modal.classList.add("aberto");
      modal.setAttribute("aria-hidden", "false");
    }
  }

  function fecharModalProduto() {
    const modal = document.getElementById("modalProduto");
    if (modal) {
      modal.classList.remove("aberto");
      modal.setAttribute("aria-hidden", "true");
    }
  }

  async function fazerUploadFotoSeNecessario() {
    const inputArquivo = document.getElementById("prodArquivoFoto");
    const urlDigitada = limparTexto(document.getElementById("prodFotoUrl").value, 1000);

    if (!inputArquivo || !inputArquivo.files || inputArquivo.files.length === 0) {
      return urlDigitada;
    }

    const arquivo = inputArquivo.files[0];
    if (arquivo.size > 5 * 1024 * 1024) {
      throw new Error("A imagem escolhida excede o limite máximo de 5MB.");
    }

    if (estado.modoDemo) {
      return URL.createObjectURL(arquivo);
    }

    const bucket = CFG.STORAGE_BUCKET || "produtos-fotos";
    const extensao = (arquivo.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
    const nomeUnico = `prod_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${extensao}`;

    const { error: uploadError } = await supabaseClient.storage
      .from(bucket)
      .upload(nomeUnico, arquivo, {
        cacheControl: "3600",
        upsert: false
      });

    if (uploadError) throw uploadError;

    const { data } = supabaseClient.storage.from(bucket).getPublicUrl(nomeUnico);
    return data.publicUrl;
  }

  async function salvarProdutoSubmit(evento) {
    evento.preventDefault();
    const alerta = document.getElementById("alertaFormProduto");
    const btnSalvar = document.getElementById("btnSalvarProduto");

    if (alerta) alerta.style.display = "none";

    const idExistente = document.getElementById("produtoIdInput").value;
    const nome = limparTexto(document.getElementById("prodNome").value, 160);
    const categoriaId = document.getElementById("prodCategoria").value || null;
    const estoque = Math.max(0, parseInt(document.getElementById("prodEstoque").value, 10) || 0);
    const descricao = limparTexto(document.getElementById("prodDescricao").value, 1000);

    const precoVenda = parseFloat(document.getElementById("prodPrecoVenda").value);
    const precoMedioRaw = document.getElementById("prodPrecoMedio").value;
    const precoMedio = precoMedioRaw !== "" ? parseFloat(precoMedioRaw) : null;
    const dataPesquisa = document.getElementById("prodDataPesquisa").value || null;

    const precoCusto = parseFloat(document.getElementById("prodPrecoCusto").value);
    const precoMinimo = parseFloat(document.getElementById("prodPrecoMinimo").value);
    const fontesPesquisa = limparTexto(
      document.getElementById("prodFontesPesquisa").value,
      1000
    );

    const ativo = document.getElementById("prodAtivo").checked;
    const destaque = document.getElementById("prodDestaque").checked;

    if (!nome) {
      alerta.textContent = "Informe o nome do produto.";
      alerta.style.display = "block";
      return;
    }

    if (isNaN(precoVenda) || precoVenda < 0 || isNaN(precoCusto) || precoCusto < 0 || isNaN(precoMinimo) || precoMinimo < 0) {
      alerta.textContent = "Verifique os valores de venda, custo e preço mínimo.";
      alerta.style.display = "block";
      return;
    }

    try {
      if (btnSalvar) {
        btnSalvar.disabled = true;
        btnSalvar.textContent = "Salvando...";
      }

      const fotoUrlFinal = await fazerUploadFotoSeNecessario();

      const dadosProduto = {
        nome,
        descricao,
        categoria_id: categoriaId,
        foto_url: fotoUrlFinal,
        preco_venda: Number(precoVenda.toFixed(2)),
        preco_medio_mercado: precoMedio !== null ? Number(precoMedio.toFixed(2)) : null,
        data_pesquisa: dataPesquisa,
        fontes_pesquisa: fontesPesquisa,
        preco_minimo_negociacao: Number(precoMinimo.toFixed(2)),
        preco_custo: Number(precoCusto.toFixed(2)),
        estoque,
        destaque,
        ativo
      };

      if (estado.modoDemo) {
        if (idExistente) {
          const idx = estado.produtos.findIndex((p) => p.id === idExistente);
          if (idx !== -1) {
            estado.produtos[idx] = { ...estado.produtos[idx], ...dadosProduto };
          }
        } else {
          estado.produtos.unshift({
            id: "demo-" + Date.now(),
            ...dadosProduto
          });
        }
      } else {
        if (idExistente) {
          const { error } = await supabaseClient
            .from("produtos")
            .update(dadosProduto)
            .eq("id", idExistente);
          if (error) throw error;
        } else {
          const { error } = await supabaseClient.from("produtos").insert([dadosProduto]);
          if (error) throw error;
        }
      }

      fecharModalProduto();
      await carregarDadosAdmin();
      mostrarToast(idExistente ? "Produto atualizado com sucesso!" : "Produto cadastrado com sucesso!");
    } catch (erro) {
      console.error("Erro ao salvar produto:", erro);
      if (alerta) {
        alerta.textContent = erro.message || "Erro ao salvar o produto.";
        alerta.style.display = "block";
      }
    } finally {
      if (btnSalvar) {
        btnSalvar.disabled = false;
        btnSalvar.textContent = "💾 Salvar Produto";
      }
    }
  }

  async function excluirProdutoAtual() {
    const id = document.getElementById("produtoIdInput").value;
    if (!id) return;

    const prod = estado.produtos.find((p) => p.id === id);
    const confirmar = window.confirm(
      `Tem certeza que deseja excluir permanentemente o produto "${prod ? prod.nome : ""}"?`
    );
    if (!confirmar) return;

    try {
      if (estado.modoDemo) {
        estado.produtos = estado.produtos.filter((p) => p.id !== id);
      } else {
        const { error } = await supabaseClient.from("produtos").delete().eq("id", id);
        if (error) throw error;
      }

      fecharModalProduto();
      await carregarDadosAdmin();
      mostrarToast("Produto excluído.");
    } catch (erro) {
      console.error("Erro ao excluir produto:", erro);
      mostrarToast("Não foi possível excluir o produto.");
    }
  }

  // ==========================================================================
  // 8. MODAL REGISTRAR VENDA (COM TRAVA/ALERTA DE PREÇO MÍNIMO DE NEGOCIAÇÃO)
  // ==========================================================================

  function abrirModalVenda(produto) {
    estado.produtoEmVenda = produto;

    const modal = document.getElementById("modalVenda");
    const elNome = document.getElementById("vendaNomeProduto");
    const elInfoRef = document.getElementById("vendaInfoReferencia");
    const inputQtd = document.getElementById("vendaQuantidade");
    const inputTotal = document.getElementById("vendaValorTotal");
    const inputObs = document.getElementById("vendaObservacao");
    const checkMin = document.getElementById("checkConfirmarAbaixoMinimo");
    const alertaErro = document.getElementById("alertaErroVenda");

    if (elNome) elNome.textContent = produto.nome;
    if (elInfoRef) {
      elInfoRef.textContent = `Estoque disponível: ${produto.estoque} ${
        Number(produto.estoque) === 1 ? "unidade" : "unidades"
      } • Preço de venda: ${formatarMoeda(
        produto.preco_venda
      )} • Preço mínimo: ${formatarMoeda(produto.preco_minimo_negociacao)}`;
    }

    if (inputQtd) {
      inputQtd.max = String(produto.estoque);
      inputQtd.value = "1";
    }
    if (inputTotal) {
      inputTotal.value = Number(produto.preco_venda).toFixed(2);
    }
    if (inputObs) inputObs.value = "";
    if (checkMin) checkMin.checked = false;
    if (alertaErro) alertaErro.style.display = "none";

    verificarAlertaPrecoMinimoVenda();

    if (modal) {
      modal.classList.add("aberto");
      modal.setAttribute("aria-hidden", "false");
    }
  }

  function fecharModalVenda() {
    const modal = document.getElementById("modalVenda");
    if (modal) {
      modal.classList.remove("aberto");
      modal.setAttribute("aria-hidden", "true");
    }
    estado.produtoEmVenda = null;
  }

  function verificarAlertaPrecoMinimoVenda() {
    const prod = estado.produtoEmVenda;
    if (!prod) return false;

    const qtd = Math.max(1, parseInt(document.getElementById("vendaQuantidade").value, 10) || 1);
    const valorTotal = parseFloat(document.getElementById("vendaValorTotal").value) || 0;
    const valorUnitario = valorTotal / qtd;
    const precoMinimo = Number(prod.preco_minimo_negociacao) || 0;

    const elUnitarioCalc = document.getElementById("vendaValorUnitarioCalc");
    if (elUnitarioCalc) {
      elUnitarioCalc.textContent = `Valor unitário nesta venda: ${formatarMoeda(valorUnitario)}`;
    }

    const blocoAlerta = document.getElementById("alertaPrecoMinimoVenda");
    const textoDetalhe = document.getElementById("textoDetalhePrecoMinimo");

    const abaixoDoMinimo = valorUnitario < precoMinimo - 0.001;

    if (blocoAlerta && textoDetalhe) {
      if (abaixoDoMinimo) {
        textoDetalhe.textContent = `O valor unitário informado (${formatarMoeda(
          valorUnitario
        )}) é menor que o preço mínimo de negociação cadastrado para este produto (${formatarMoeda(
          precoMinimo
        )}).`;
        blocoAlerta.style.display = "block";
      } else {
        blocoAlerta.style.display = "none";
      }
    }

    return abaixoDoMinimo;
  }

  async function confirmarVendaSubmit(evento) {
    evento.preventDefault();
    const prod = estado.produtoEmVenda;
    if (!prod) return;

    const alertaErro = document.getElementById("alertaErroVenda");
    const btnConfirmar = document.getElementById("btnConfirmarVenda");
    if (alertaErro) alertaErro.style.display = "none";

    const qtd = parseInt(document.getElementById("vendaQuantidade").value, 10) || 0;
    const valorTotal = parseFloat(document.getElementById("vendaValorTotal").value);
    const observacao = limparTexto(document.getElementById("vendaObservacao").value, 300);

    if (qtd <= 0 || qtd > Number(prod.estoque)) {
      alertaErro.textContent = `Quantidade inválida. Disponível em estoque: ${prod.estoque} ${
        Number(prod.estoque) === 1 ? "unidade" : "unidades"
      }.`;
      alertaErro.style.display = "block";
      return;
    }

    if (isNaN(valorTotal) || valorTotal < 0) {
      alertaErro.textContent = "Informe um valor total válido.";
      alertaErro.style.display = "block";
      return;
    }

    const abaixoDoMinimo = verificarAlertaPrecoMinimoVenda();
    const checkConfirmado = document.getElementById("checkConfirmarAbaixoMinimo").checked;

    if (abaixoDoMinimo && !checkConfirmado) {
      alertaErro.textContent =
        "Para prosseguir com valor abaixo do preço mínimo, marque a caixa de confirmação no alerta laranja acima.";
      alertaErro.style.display = "block";
      return;
    }

    try {
      if (btnConfirmar) {
        btnConfirmar.disabled = true;
        btnConfirmar.textContent = "Registrando...";
      }

      if (estado.modoDemo) {
        prod.estoque = Math.max(0, Number(prod.estoque) - qtd);
        estado.vendasMes.unshift({
          id: "v-" + Date.now(),
          produto_id: prod.id,
          nome_produto_snapshot: prod.nome,
          quantidade: qtd,
          valor_unitario: Number((valorTotal / qtd).toFixed(2)),
          valor_total: Number(valorTotal.toFixed(2)),
          custo_unitario_snapshot: Number(prod.preco_custo) || 0,
          abaixo_preco_minimo: abaixoDoMinimo,
          observacao,
          data_venda: new Date().toISOString()
        });
      } else {
        // Chama a função transacional segura criada no setup.sql
        const { error } = await supabaseClient.rpc("registrar_venda_admin", {
          p_produto_id: prod.id,
          p_quantidade: qtd,
          p_valor_total: Number(valorTotal.toFixed(2)),
          p_observacao: observacao
        });

        if (error) throw error;
      }

      fecharModalVenda();
      await carregarDadosAdmin();
      mostrarToast("Venda registrada e estoque atualizado!");
    } catch (erro) {
      console.error("Erro ao registrar venda:", erro);
      if (alertaErro) {
        alertaErro.textContent = erro.message || "Erro ao registrar a venda.";
        alertaErro.style.display = "block";
      }
    } finally {
      if (btnConfirmar) {
        btnConfirmar.disabled = false;
        btnConfirmar.textContent = "✅ Confirmar Venda e Baixar Estoque";
      }
    }
  }

  // ==========================================================================
  // 9. GERENCIADOR DE CATEGORIAS
  // ==========================================================================

  function abrirModalCategorias() {
    const modal = document.getElementById("modalCategorias");
    renderizarListaCategoriasModal();
    if (modal) {
      modal.classList.add("aberto");
      modal.setAttribute("aria-hidden", "false");
    }
  }

  function fecharModalCategorias() {
    const modal = document.getElementById("modalCategorias");
    if (modal) {
      modal.classList.remove("aberto");
      modal.setAttribute("aria-hidden", "true");
    }
  }

  function renderizarListaCategoriasModal() {
    const container = document.getElementById("listaCategoriasGerenciar");
    if (!container) return;
    container.textContent = "";

    estado.categorias.forEach((cat) => {
      const linha = document.createElement("div");
      linha.className = "carrinho-item";

      const span = document.createElement("span");
      span.style.fontWeight = "700";
      span.textContent = cat.nome;

      const btnDel = document.createElement("button");
      btnDel.type = "button";
      btnDel.className = "btn-secundario-admin";
      btnDel.style.minHeight = "34px";
      btnDel.style.padding = "0 10px";
      btnDel.textContent = "Excluir";
      btnDel.addEventListener("click", () => excluirCategoria(cat));

      linha.appendChild(span);
      linha.appendChild(btnDel);
      container.appendChild(linha);
    });
  }

  async function adicionarCategoriaSubmit(evento) {
    evento.preventDefault();
    const input = document.getElementById("inputNomeNovaCategoria");
    const nome = limparTexto(input.value, 80);
    if (!nome) return;

    const slug = gerarSlug(nome) || "cat-" + Date.now();

    try {
      if (estado.modoDemo) {
        estado.categorias.push({
          id: "cat-" + Date.now(),
          nome,
          slug,
          ordem: estado.categorias.length + 1
        });
      } else {
        const { error } = await supabaseClient
          .from("categorias")
          .insert([{ nome, slug, ordem: estado.categorias.length + 1 }]);
        if (error) throw error;
      }

      input.value = "";
      await carregarDadosAdmin();
      renderizarListaCategoriasModal();
      mostrarToast("Categoria criada!");
    } catch (erro) {
      console.error("Erro ao criar categoria:", erro);
      mostrarToast("Não foi possível criar a categoria.");
    }
  }

  async function excluirCategoria(cat) {
    if (!window.confirm(`Deseja remover a categoria "${cat.nome}"?`)) return;

    try {
      if (estado.modoDemo) {
        estado.categorias = estado.categorias.filter((c) => c.id !== cat.id);
      } else {
        const { error } = await supabaseClient.from("categorias").delete().eq("id", cat.id);
        if (error) throw error;
      }
      await carregarDadosAdmin();
      renderizarListaCategoriasModal();
      mostrarToast("Categoria removida.");
    } catch (erro) {
      console.error("Erro ao remover categoria:", erro);
      mostrarToast("Erro ao remover categoria.");
    }
  }

  // ==========================================================================
  // 10. EVENTOS E INICIALIZAÇÃO DO PAINEL
  // ==========================================================================

  function selecionarChipFiltro(novoFiltro) {
    estado.chipFiltro = novoFiltro;
    document.querySelectorAll(".chip-filtro").forEach((btn) => {
      btn.classList.toggle("ativo", btn.dataset.filtro === novoFiltro);
    });
    renderizarListaProdutos();
  }

  function configurarEventosAdmin() {
    // Login submit
    const formLogin = document.getElementById("formLogin");
    if (formLogin) {
      formLogin.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!supabaseConfigurado()) {
          exibirTelaLogin(
            "Configure primeiro a SUPABASE_URL e a SUPABASE_ANON_KEY no arquivo config.js, ou clique no botão de Demonstração abaixo."
          );
          return;
        }

        const email = limparTexto(document.getElementById("inputEmailLogin").value, 160);
        const password = document.getElementById("inputSenhaLogin").value;
        const btn = document.getElementById("btnEntrarLogin");

        try {
          btn.disabled = true;
          btn.textContent = "Verificando...";
          const { data, error } = await supabaseClient.auth.signInWithPassword({
            email,
            password
          });
          if (error) throw error;
          await exibirPainelAutenticado(data.user);
        } catch (erro) {
          exibirTelaLogin("E-mail ou senha inválidos. Verifique suas credenciais.");
        } finally {
          btn.disabled = false;
          btn.textContent = "🔒 Entrar no Painel";
        }
      });
    }

    // Botão de modo demonstração (quando Supabase ainda não está configurado)
    const btnDemo = document.getElementById("btnEntrarDemoAdmin");
    if (btnDemo) {
      btnDemo.addEventListener("click", () => {
        estado.modoDemo = true;
        exibirPainelAutenticado({ email: "socio@precosjustos.pg" });
      });
    }

    // Botão Sair
    const btnSair = document.getElementById("btnSairAdmin");
    if (btnSair) {
      btnSair.addEventListener("click", async () => {
        if (supabaseClient && !estado.modoDemo) {
          await supabaseClient.auth.signOut();
        }
        estado.usuario = null;
        exibirTelaLogin();
      });
    }

    // Cards clicáveis do resumo (atalho para filtrar estoque baixo e pesquisa > 60d)
    const cardEstoqueBaixo = document.getElementById("cardAlertaEstoqueBaixo");
    const cardPesquisaAntiga = document.getElementById("cardAlertaPesquisaAntiga");
    if (cardEstoqueBaixo) {
      cardEstoqueBaixo.addEventListener("click", () => selecionarChipFiltro("estoque_baixo"));
    }
    if (cardPesquisaAntiga) {
      cardPesquisaAntiga.addEventListener("click", () => selecionarChipFiltro("pesquisa_vencida"));
    }

    // Busca e filtros
    const inputBusca = document.getElementById("inputBuscaAdmin");
    if (inputBusca) {
      inputBusca.addEventListener("input", () => {
        estado.busca = inputBusca.value || "";
        renderizarListaProdutos();
      });
    }

    const selectCat = document.getElementById("selectCategoriaAdmin");
    if (selectCat) {
      selectCat.addEventListener("change", () => {
        estado.categoriaFiltro = selectCat.value;
        renderizarListaProdutos();
      });
    }

    document.querySelectorAll(".chip-filtro").forEach((btn) => {
      btn.addEventListener("click", () => selecionarChipFiltro(btn.dataset.filtro));
    });

    // Modal de Produto
    document
      .getElementById("btnNovoProduto")
      ?.addEventListener("click", () => abrirModalProduto(null));
    document
      .getElementById("btnFecharModalProduto")
      ?.addEventListener("click", fecharModalProduto);
    document
      .getElementById("btnCancelarProduto")
      ?.addEventListener("click", fecharModalProduto);
    document
      .getElementById("formProduto")
      ?.addEventListener("submit", salvarProdutoSubmit);
    document
      .getElementById("btnExcluirProdutoModal")
      ?.addEventListener("click", excluirProdutoAtual);

    // Prévia instantânea de foto no modal
    const inputFotoUrl = document.getElementById("prodFotoUrl");
    const inputArquivoFoto = document.getElementById("prodArquivoFoto");
    const imgPreview = document.getElementById("previewFotoProduto");

    if (inputFotoUrl && imgPreview) {
      inputFotoUrl.addEventListener("input", () => {
        imgPreview.src = inputFotoUrl.value.trim() || obterFotoPlaceholder();
      });
    }
    if (inputArquivoFoto && imgPreview) {
      inputArquivoFoto.addEventListener("change", () => {
        if (inputArquivoFoto.files && inputArquivoFoto.files[0]) {
          imgPreview.src = URL.createObjectURL(inputArquivoFoto.files[0]);
        }
      });
    }

    // Modal de Venda
    document
      .getElementById("btnFecharModalVenda")
      ?.addEventListener("click", fecharModalVenda);
    document
      .getElementById("btnCancelarVenda")
      ?.addEventListener("click", fecharModalVenda);
    document
      .getElementById("formVenda")
      ?.addEventListener("submit", confirmarVendaSubmit);

    const inputVendaQtd = document.getElementById("vendaQuantidade");
    const inputVendaTotal = document.getElementById("vendaValorTotal");
    if (inputVendaQtd && inputVendaTotal) {
      inputVendaQtd.addEventListener("input", () => {
        if (estado.produtoEmVenda) {
          const q = Math.max(1, parseInt(inputVendaQtd.value, 10) || 1);
          inputVendaTotal.value = (Number(estado.produtoEmVenda.preco_venda) * q).toFixed(2);
        }
        verificarAlertaPrecoMinimoVenda();
      });
      inputVendaTotal.addEventListener("input", verificarAlertaPrecoMinimoVenda);
    }

    // Modal de Categorias
    document
      .getElementById("btnGerenciarCategorias")
      ?.addEventListener("click", abrirModalCategorias);
    document
      .getElementById("btnFecharModalCategorias")
      ?.addEventListener("click", fecharModalCategorias);
    document
      .getElementById("formNovaCategoria")
      ?.addEventListener("submit", adicionarCategoriaSubmit);
  }

  document.addEventListener("DOMContentLoaded", async () => {
    configurarEventosAdmin();

    if (!supabaseConfigurado() || !window.supabase) {
      const blocoDemo = document.getElementById("blocoDemoAdmin");
      if (blocoDemo) blocoDemo.style.display = "block";
      exibirTelaLogin();
      return;
    }

    supabaseClient = window.supabase.createClient(
      CFG.SUPABASE_URL,
      CFG.SUPABASE_ANON_KEY
    );

    const { data } = await supabaseClient.auth.getSession();
    if (data && data.session && data.session.user) {
      await exibirPainelAutenticado(data.session.user);
    } else {
      exibirTelaLogin();
    }
  });
})();

