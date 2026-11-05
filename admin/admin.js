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

  const CATEGORIAS_ORGANIZADAS_PADRAO = [
    {
      nome: "Casa e Cômodos",
      slug: "casa-e-comodos",
      subcategorias: ["Cozinha", "Sala", "Quarto", "Banheiro", "Lavanderia e Limpeza", "Jardim e Varanda"],
      ordem: 1
    },
    {
      nome: "Cuidados Pessoais e Beleza",
      slug: "cuidados-pessoais",
      subcategorias: ["Feminino", "Masculino", "Unissex", "Infantil", "Perfumaria", "Cabelo e Barba"],
      ordem: 2
    },
    {
      nome: "Moda, Bolsas e Acessórios",
      slug: "moda-e-acessorios",
      subcategorias: ["Feminino", "Masculino", "Unissex", "Infantil", "Relógios e Óculos", "Bolsas e Carteiras"],
      ordem: 3
    },
    {
      nome: "Eletrônicos e Tecnologia",
      slug: "eletronicos-e-tecnologia",
      subcategorias: ["Áudio e Fones", "Celular e Carregadores", "Informática", "Smartwatch", "Caixas de Som"],
      ordem: 4
    },
    {
      nome: "Ferramentas e Utilidades",
      slug: "ferramentas-e-utilidades",
      subcategorias: ["Ferramentas Manuais", "Elétrica e Iluminação", "Automotivo", "Organização"],
      ordem: 5
    },
    {
      nome: "Infantil e Brinquedos",
      slug: "infantil-e-brinquedos",
      subcategorias: ["Meninos", "Meninas", "Bebês", "Jogos e Educativos"],
      ordem: 6
    },
    {
      nome: "Kits e Promoções",
      slug: "kits-e-promocoes",
      subcategorias: ["Kits Presente Masculino", "Kits Presente Feminino", "Kits para Casa", "Queima de Estoque"],
      ordem: 7
    },
    {
      nome: "Bebidas",
      slug: "bebidas",
      subcategorias: ["Bebidas Alcoólicas", "Refrigerantes e Sucos", "Águas e Energéticos"],
      ordem: 8
    }
  ];

  const estado = {
    modoDemo: false,
    usuario: null,
    categorias: [],
    produtos: [],
    vendasMes: [],
    todasVendas: [],
    clientes: [],
    areasEntrega: [],
    fotosProdutoModal: [],
    mesRelatorioSelecionado: "",
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
    estado.todasVendas = [...estado.vendasMes];
    estado.clientes = [
      {
        id: "cli-demo-1",
        nome: "Maria Oliveira",
        email: "maria@exemplo.com",
        whatsapp: "(71) 99999-1111",
        endereco: "Rua das Flores, nº 45, Pituba, Salvador - BA",
        criado_em: new Date().toISOString()
      }
    ];
  }

  function carregarClientesLocaisFallback() {
    try {
      const lista = JSON.parse(
        localStorage.getItem("pg_precos_justos_contas_clientes_v1") || "[]"
      );
      return Array.isArray(lista) ? lista : [];
    } catch (_) {
      return [];
    }
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

      const [resCat, resProd, resVendas, resClientes] = await Promise.all([
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
          .order("data_venda", { ascending: false }),
        supabaseClient
          .from("clientes")
          .select("*")
          .order("criado_em", { ascending: false })
      ]);

      if (resCat.error) throw resCat.error;
      if (resProd.error) throw resProd.error;
      if (resVendas.error) throw resVendas.error;

      estado.categorias = resCat.data || [];
      estado.produtos = resProd.data || [];
      estado.todasVendas = resVendas.data || [];
      estado.vendasMes = estado.todasVendas.filter(
        (v) => new Date(v.data_venda) >= inicioMes
      );

      if (!resClientes.error && Array.isArray(resClientes.data)) {
        estado.clientes = resClientes.data;
      } else {
        estado.clientes = carregarClientesLocaisFallback();
      }

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
      custoVendasMes += custoTotal + obterTaxaVenda(v) + obterFreteVenda(v);
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

  function obterNomeCategoria(categoriaId, subcategoria) {
    const cat = estado.categorias.find((c) => String(c.id) === String(categoriaId));
    const nomeCat = cat ? cat.nome : "Sem categoria";
    return subcategoria ? `${nomeCat} • ${subcategoria}` : nomeCat;
  }

  function atualizarSugestoesSubcategoria(categoriaId) {
    const datalist = document.getElementById("sugestoesSubcategoria");
    if (!datalist) return;
    datalist.textContent = "";

    const cat = estado.categorias.find((c) => String(c.id) === String(categoriaId));
    let opcoes = [];
    if (cat && Array.isArray(cat.subcategorias) && cat.subcategorias.length > 0) {
      opcoes = cat.subcategorias;
    } else if (cat) {
      const padrao = CATEGORIAS_ORGANIZADAS_PADRAO.find((p) => p.slug === cat.slug);
      if (padrao) opcoes = padrao.subcategorias;
    }

    if (opcoes.length === 0) {
      opcoes = [
        "Cozinha",
        "Sala",
        "Quarto",
        "Banheiro",
        "Lavanderia e Limpeza",
        "Masculino",
        "Feminino",
        "Unissex",
        "Infantil"
      ];
    }

    opcoes.forEach((item) => {
      const opt = document.createElement("option");
      opt.value = item;
      datalist.appendChild(opt);
    });
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
    cat.textContent = obterNomeCategoria(produto.categoria_id, produto.subcategoria);

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
  // 7. MODAL ADICIONAR / EDITAR PRODUTO + FOTOS ILIMITADAS + IMPORTADOR POR LINK
  // ==========================================================================

  function renderizarFotosProdutoAdmin() {
    const container = document.getElementById("listaFotosProdutoAdmin");
    const imgPreview = document.getElementById("previewFotoProduto");
    if (!container) return;

    container.textContent = "";

    const fotos = estado.fotosProdutoModal || [];
    if (imgPreview) {
      imgPreview.src = fotos[0] || obterFotoPlaceholder();
    }

    fotos.forEach((url, idx) => {
      const card = document.createElement("div");
      card.className = "item-foto-admin" + (idx === 0 ? " principal" : "");
      card.title = idx === 0 ? "Foto Principal (capa)" : "Toque na imagem para definir como principal";

      const img = document.createElement("img");
      img.src = url;
      img.alt = `Foto ${idx + 1}`;
      img.style.cursor = "pointer";
      img.addEventListener("click", () => {
        // Move esta foto para a posição 0 (principal)
        const escolhida = estado.fotosProdutoModal.splice(idx, 1)[0];
        estado.fotosProdutoModal.unshift(escolhida);
        renderizarFotosProdutoAdmin();
      });
      card.appendChild(img);

      const btnRem = document.createElement("button");
      btnRem.type = "button";
      btnRem.className = "btn-remover-foto-admin";
      btnRem.textContent = "✕";
      btnRem.title = "Remover esta foto";
      btnRem.addEventListener("click", (e) => {
        e.stopPropagation();
        estado.fotosProdutoModal.splice(idx, 1);
        renderizarFotosProdutoAdmin();
      });
      card.appendChild(btnRem);

      if (idx === 0) {
        const tag = document.createElement("span");
        tag.className = "tag-foto-principal-admin";
        tag.textContent = "Principal";
        card.appendChild(tag);
      }

      container.appendChild(card);
    });
  }

  function adicionarFotoUrlNoModal() {
    const inputUrl = document.getElementById("prodFotoUrl");
    if (!inputUrl) return;
    const url = limparTexto(inputUrl.value, 1000);
    if (!url || !/^https?:\/\//i.test(url)) {
      mostrarToast("Informe um link de imagem válido começando com http:// ou https://");
      return;
    }
    if (!estado.fotosProdutoModal.includes(url)) {
      estado.fotosProdutoModal.push(url);
    }
    inputUrl.value = "";
    renderizarFotosProdutoAdmin();
    mostrarToast("📸 Foto adicionada à galeria do produto!");
  }

  /**
   * Limpa títulos de lojas externas (remove IDs tipo MLB-123456, SKUs, nomes de sites e códigos)
   */
  function limparTituloImportadoDeLink(tituloBruto) {
    let t = String(tituloBruto || "").trim();
    // Remove sufixos de lojas conhecidas
    t = t.replace(/\s*[\|\-–—]\s*(Mercado Livre|MercadoLivre|Shopee.*|Amazon\.com\.br.*|Amazon.*|Magazine Luiza.*|Magalu.*|Americanas.*|Casas Bahia.*|AliExpress.*)$/i, "");
    // Remove códigos de anúncio como MLB12345678, MLB-12345678, SKU: 12345, Cód. 12345, Ref: 1234
    t = t.replace(/\bMLB-?\d+\b/gi, "");
    t = t.replace(/\b(SKU|C[oó]d\.?|C[oó]digo|Ref\.?|ID)\s*[:#\-]?\s*[A-Z0-9\-_]+\b/gi, "");
    t = t.replace(/\(\s*\)/g, "");
    t = t.replace(/\s{2,}/g, " ").trim();
    return limparTexto(t, 160);
  }

  /**
   * Organiza e limpa a descrição extraída de um link externo, mantendo apenas dados gerais do produto
   */
  function organizarDescricaoImportada(descBruta, tituloLimpo) {
    let d = String(descBruta || "").trim();
    // Remove frases promocionais ou específicas do vendedor/site externo
    const padroesRemover = [
      /compre\s+online[^.!\n]*[.!\n]?/gi,
      /frete\s+gr[aá]tis[^.!\n]*[.!\n]?/gi,
      /parcele\s+em\s+at[eé][^.!\n]*[.!\n]?/gi,
      /mercado\s+livre[^.!\n]*[.!\n]?/gi,
      /shopee[^.!\n]*[.!\n]?/gi,
      /amazon\.com\.br[^.!\n]*[.!\n]?/gi,
      /encontre\s+mais\s+produtos[^.!\n]*[.!\n]?/gi,
      /\bMLB-?\d+\b/gi,
      /\b(SKU|C[oó]d\.?|C[oó]digo|ID\s+do\s+an[uú]ncio)\s*[:#\-]?\s*[A-Z0-9\-_]+\b/gi
    ];
    padroesRemover.forEach((rx) => {
      d = d.replace(rx, "");
    });
    d = d.replace(/\s{2,}/g, " ").trim();

    if (!d || d.length < 10) {
      return tituloLimpo
        ? `${tituloLimpo}.\n• Produto selecionado com excelente qualidade e ótimo custo-benefício.\n• Disponível para pronta entrega ou retirada.`
        : "";
    }

    // Organiza em tópicos limpos se for um texto corrido longo
    const frases = d
      .split(/(?<=[.!?])\s+/)
      .map((f) => f.trim())
      .filter((f) => f.length > 4);

    if (frases.length > 1) {
      return limparTexto(frases.map((f) => `• ${f}`).join("\n"), 950);
    }
    return limparTexto(d, 950);
  }

  /**
   * Extrai nome legível a partir da própria URL (slug) caso o site bloqueie leitura externa
   */
  function extrairTituloDoSlugUrl(urlStr) {
    try {
      const u = new URL(urlStr);
      const partes = u.pathname
        .split("/")
        .map((p) => decodeURIComponent(p))
        .filter((p) => p.length > 3 && !/^(p|dp|gp|product|item|produto)$/i.test(p));
      if (partes.length === 0) return "";
      // Pega a parte mais descritiva do caminho
      const melhor = partes.sort((a, b) => b.length - a.length)[0];
      let limpo = melhor
        .replace(/MLB-?\d+/gi, "")
        .replace(/i\.\d+\.\d+/gi, "")
        .replace(/_JM$/i, "")
        .replace(/\.html?$/i, "")
        .replace(/[-_]+/g, " ")
        .trim();
      limpo = limpo.replace(/\b\w/g, (l) => l.toUpperCase());
      return limparTituloImportadoDeLink(limpo);
    } catch (_) {
      return "";
    }
  }

  async function importarDadosPorLinkProduto() {
    const inputLink = document.getElementById("inputLinkImportarProduto");
    const btnImportar = document.getElementById("btnImportarLinkProduto");
    const feedback = document.getElementById("feedbackImportarLink");
    const url = String(inputLink?.value || "").trim();

    if (!url || !/^https?:\/\//i.test(url)) {
      mostrarToast("Cole um link válido começando com https://");
      inputLink?.focus();
      return;
    }

    try {
      if (btnImportar) {
        btnImportar.disabled = true;
        btnImportar.textContent = "⏳ Extraindo...";
      }
      if (feedback) {
        feedback.textContent = "Analisando link e organizando informações gerais do produto...";
      }

      let tituloExtraido = "";
      let descricaoExtraida = "";
      let fotosExtraidas = [];
      let precoReferencia = null;

      // 1. Tenta consultar metadados estruturados via Microlink API (OpenGraph / JSON-LD)
      try {
        const resp = await fetch(`https://api.microlink.io/?url=${encodeURIComponent(url)}`);
        if (resp.ok) {
          const json = await resp.json();
          const dados = json?.data || {};
          if (dados.title) tituloExtraido = dados.title;
          if (dados.description) descricaoExtraida = dados.description;
          if (dados.image?.url && /^https?:\/\//i.test(dados.image.url)) {
            fotosExtraidas.push(dados.image.url);
          }
        }
      } catch (_) {}

      // 2. Fallback inteligente pelo slug da URL se o título vier vazio ou genérico
      if (
        !tituloExtraido ||
        /^(Mercado Livre|Shopee|Amazon|login|captcha|aten[cç][aã]o)/i.test(tituloExtraido.trim())
      ) {
        tituloExtraido = extrairTituloDoSlugUrl(url);
      }

      const tituloLimpo = limparTituloImportadoDeLink(tituloExtraido);
      const descricaoOrganizada = organizarDescricaoImportada(descricaoExtraida, tituloLimpo);

      if (tituloLimpo) {
        document.getElementById("prodNome").value = tituloLimpo;
      }
      if (descricaoOrganizada) {
        document.getElementById("prodDescricao").value = descricaoOrganizada;
      }

      if (fotosExtraidas.length > 0) {
        fotosExtraidas.forEach((fUrl) => {
          if (!estado.fotosProdutoModal.includes(fUrl)) {
            estado.fotosProdutoModal.push(fUrl);
          }
        });
        renderizarFotosProdutoAdmin();
      }

      // Registra apenas o domínio como fonte de pesquisa para controle interno do Admin (sem colar IDs na vitrine)
      try {
        const dominio = new URL(url).hostname.replace(/^www\./i, "");
        const campoFontes = document.getElementById("prodFontesPesquisa");
        if (campoFontes && !campoFontes.value) {
          campoFontes.value = `Referência consultada em: ${dominio}`;
        }
      } catch (_) {}

      if (precoReferencia && !document.getElementById("prodPrecoMedio").value) {
        document.getElementById("prodPrecoMedio").value = Number(precoReferencia).toFixed(2);
      }

      // Detecta automaticamente se é bebida alcoólica (+18)
      const textoCompleto = `${tituloLimpo} ${descricaoOrganizada}`.toLowerCase();
      if (
        textoCompleto.includes("cerveja") ||
        textoCompleto.includes("vinho") ||
        textoCompleto.includes("whisky") ||
        textoCompleto.includes("vodka") ||
        textoCompleto.includes("cachaça") ||
        textoCompleto.includes("licor") ||
        textoCompleto.includes("alcoól")
      ) {
        const chk18 = document.getElementById("prodMaiorIdade");
        if (chk18) chk18.checked = true;
      }

      if (feedback) {
        feedback.textContent = tituloLimpo
          ? "✅ Informações gerais extraídas e organizadas! Confira os campos abaixo e defina seu preço."
          : "⚠️ O site externo protegeu parte dos dados. Preencha ou ajuste os campos abaixo.";
      }
      mostrarToast("⚡ Informações do produto extraídas e organizadas!");
    } catch (erro) {
      console.error("Erro ao importar link:", erro);
      if (feedback) {
        feedback.textContent = "Não foi possível ler todos os dados automaticamente deste link.";
      }
    } finally {
      if (btnImportar) {
        btnImportar.disabled = false;
        btnImportar.textContent = "⚡ Extrair e Organizar";
      }
    }
  }

  function abrirModalProduto(produto = null) {
    const modal = document.getElementById("modalProduto");
    const titulo = document.getElementById("tituloModalProduto");
    const alerta = document.getElementById("alertaFormProduto");
    const btnExcluir = document.getElementById("btnExcluirProdutoModal");
    const inputArquivo = document.getElementById("prodArquivoFoto");
    const inputLinkImportar = document.getElementById("inputLinkImportarProduto");
    const feedbackImportar = document.getElementById("feedbackImportarLink");

    if (alerta) alerta.style.display = "none";
    if (inputArquivo) inputArquivo.value = "";
    if (inputLinkImportar) inputLinkImportar.value = "";
    if (feedbackImportar) {
      feedbackImportar.textContent =
        "Extrai apenas as informações gerais e importantes do produto (sem copiar códigos ou IDs da outra loja).";
    }

    atualizarSelectsCategorias();

    if (produto) {
      if (titulo) titulo.textContent = "✏️ Editar Produto";
      document.getElementById("produtoIdInput").value = produto.id;
      document.getElementById("prodNome").value = produto.nome || "";
      document.getElementById("prodCategoria").value = produto.categoria_id || "";
      atualizarSugestoesSubcategoria(produto.categoria_id || "");
      const elSub = document.getElementById("prodSubcategoria");
      if (elSub) elSub.value = produto.subcategoria || "";
      document.getElementById("prodEstoque").value = Number(produto.estoque) || 0;
      document.getElementById("prodDescricao").value = produto.descricao || "";
      document.getElementById("prodFotoUrl").value = "";

      const listaFotos = [];
      if (produto.foto_url && /^https?:\/\//i.test(String(produto.foto_url).trim())) {
        listaFotos.push(String(produto.foto_url).trim());
      }
      if (Array.isArray(produto.fotos_urls)) {
        produto.fotos_urls.forEach((u) => {
          const limpa = String(u || "").trim();
          if (/^https?:\/\//i.test(limpa) && !listaFotos.includes(limpa)) {
            listaFotos.push(limpa);
          }
        });
      }
      estado.fotosProdutoModal = listaFotos;
      renderizarFotosProdutoAdmin();

      document.getElementById("prodPrecoVenda").value = produto.preco_venda ?? "";
      document.getElementById("prodPrecoMedio").value =
        produto.preco_medio_mercado ?? "";
      document.getElementById("prodPrecoCusto").value = produto.preco_custo ?? 0;
      document.getElementById("prodPrecoMinimo").value =
        produto.preco_minimo_negociacao ?? 0;
      document.getElementById("prodFontesPesquisa").value =
        produto.fontes_pesquisa || "";
      document.getElementById("prodAtivo").checked = Boolean(produto.ativo);
      document.getElementById("prodDestaque").checked = Boolean(produto.destaque);
      const chkMaior18 = document.getElementById("prodMaiorIdade");
      if (chkMaior18) chkMaior18.checked = Boolean(produto.maior_idade);
      if (btnExcluir) btnExcluir.style.display = "inline-flex";
    } else {
      if (titulo) titulo.textContent = "➕ Adicionar Novo Produto";
      document.getElementById("produtoIdInput").value = "";
      document.getElementById("prodNome").value = "";
      const catInicial = estado.categorias[0] ? String(estado.categorias[0].id) : "";
      document.getElementById("prodCategoria").value = catInicial;
      atualizarSugestoesSubcategoria(catInicial);
      const elSub = document.getElementById("prodSubcategoria");
      if (elSub) elSub.value = "";
      document.getElementById("prodEstoque").value = 1;
      document.getElementById("prodDescricao").value = "";
      document.getElementById("prodFotoUrl").value = "";
      estado.fotosProdutoModal = [];
      renderizarFotosProdutoAdmin();
      document.getElementById("prodPrecoVenda").value = "";
      document.getElementById("prodPrecoMedio").value = "";
      document.getElementById("prodPrecoCusto").value = "";
      document.getElementById("prodPrecoMinimo").value = "";
      document.getElementById("prodFontesPesquisa").value = "";
      document.getElementById("prodAtivo").checked = true;
      document.getElementById("prodDestaque").checked = false;
      const chkMaior18 = document.getElementById("prodMaiorIdade");
      if (chkMaior18) chkMaior18.checked = false;
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

  async function fazerUploadMultiplasFotosSeNecessario() {
    const inputArquivo = document.getElementById("prodArquivoFoto");
    const urlDigitada = limparTexto(document.getElementById("prodFotoUrl")?.value || "", 1000);
    const urlsFinais = [...(estado.fotosProdutoModal || [])];

    if (urlDigitada && /^https?:\/\//i.test(urlDigitada) && !urlsFinais.includes(urlDigitada)) {
      urlsFinais.push(urlDigitada);
    }

    if (inputArquivo && inputArquivo.files && inputArquivo.files.length > 0) {
      const arquivos = Array.from(inputArquivo.files);
      const bucket = CFG.STORAGE_BUCKET || "produtos-fotos";

      for (const arquivo of arquivos) {
        if (arquivo.size > 5 * 1024 * 1024) {
          throw new Error(`A imagem "${arquivo.name}" excede o limite máximo de 5MB.`);
        }
        if (estado.modoDemo) {
          urlsFinais.push(URL.createObjectURL(arquivo));
        } else {
          const extensao = (arquivo.name.split(".").pop() || "jpg")
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "");
          const nomeUnico = `prod_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${extensao}`;

          const { error: uploadError } = await supabaseClient.storage
            .from(bucket)
            .upload(nomeUnico, arquivo, {
              cacheControl: "3600",
              upsert: false
            });

          if (uploadError) throw uploadError;

          const { data } = supabaseClient.storage.from(bucket).getPublicUrl(nomeUnico);
          if (data?.publicUrl) {
            urlsFinais.push(data.publicUrl);
          }
        }
      }
    }

    return urlsFinais;
  }

  async function salvarProdutoSubmit(evento) {
    evento.preventDefault();
    const alerta = document.getElementById("alertaFormProduto");
    const btnSalvar = document.getElementById("btnSalvarProduto");

    if (alerta) alerta.style.display = "none";

    const idExistente = document.getElementById("produtoIdInput").value;
    const nome = limparTexto(document.getElementById("prodNome").value, 160);
    const categoriaId = document.getElementById("prodCategoria").value || null;
    const subcategoria = limparTexto(
      document.getElementById("prodSubcategoria")?.value || "",
      80
    );
    const estoque = Math.max(0, parseInt(document.getElementById("prodEstoque").value, 10) || 0);
    const descricao = limparTexto(document.getElementById("prodDescricao").value, 1000);

    const precoVenda = parseFloat(document.getElementById("prodPrecoVenda").value);
    const precoMedioRaw = document.getElementById("prodPrecoMedio").value;
    const precoMedio = precoMedioRaw !== "" ? parseFloat(precoMedioRaw) : null;
    const produtoAnterior = idExistente
      ? estado.produtos.find((p) => String(p.id) === String(idExistente))
      : null;
    let dataPesquisa = produtoAnterior?.data_pesquisa || null;
    if (
      precoMedio !== null &&
      (!dataPesquisa || Number(produtoAnterior?.preco_medio_mercado) !== precoMedio)
    ) {
      dataPesquisa = hojeISO();
    }

    const precoCusto = parseFloat(document.getElementById("prodPrecoCusto").value);
    const precoMinimo = parseFloat(document.getElementById("prodPrecoMinimo").value);
    const fontesPesquisa = limparTexto(
      document.getElementById("prodFontesPesquisa").value,
      1000
    );

    const ativo = document.getElementById("prodAtivo").checked;
    const destaque = document.getElementById("prodDestaque").checked;
    const maiorIdade = Boolean(document.getElementById("prodMaiorIdade")?.checked);

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

      const todasFotosUrls = await fazerUploadMultiplasFotosSeNecessario();
      const fotoUrlPrincipal = todasFotosUrls[0] || "";

      const dadosProdutoBase = {
        nome,
        descricao,
        categoria_id: categoriaId,
        subcategoria,
        foto_url: fotoUrlPrincipal,
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

      const dadosProdutoCompleto = {
        ...dadosProdutoBase,
        fotos_urls: todasFotosUrls,
        maior_idade: maiorIdade
      };

      if (estado.modoDemo) {
        if (idExistente) {
          const idx = estado.produtos.findIndex((p) => p.id === idExistente);
          if (idx !== -1) {
            estado.produtos[idx] = { ...estado.produtos[idx], ...dadosProdutoCompleto };
          }
        } else {
          estado.produtos.unshift({
            id: "demo-" + Date.now(),
            ...dadosProdutoCompleto
          });
        }
      } else {
        if (idExistente) {
          let { error } = await supabaseClient
            .from("produtos")
            .update(dadosProdutoCompleto)
            .eq("id", idExistente);
          // Fallback caso as colunas fotos_urls / maior_idade ainda não tenham sido criadas no banco
          if (
            error &&
            (String(error.message || "").includes("fotos_urls") ||
              String(error.message || "").includes("maior_idade"))
          ) {
            const retry = await supabaseClient
              .from("produtos")
              .update(dadosProdutoBase)
              .eq("id", idExistente);
            error = retry.error;
          }
          if (error) throw error;
        } else {
          let { error } = await supabaseClient.from("produtos").insert([dadosProdutoCompleto]);
          if (
            error &&
            (String(error.message || "").includes("fotos_urls") ||
              String(error.message || "").includes("maior_idade"))
          ) {
            const retry = await supabaseClient.from("produtos").insert([dadosProdutoBase]);
            error = retry.error;
          }
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
    document.getElementById("vendaTaxa").value = "";
    document.getElementById("vendaFrete").value = "";
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
    const taxa = lerValorMonetario(document.getElementById("vendaTaxa").value);
    const frete = lerValorMonetario(document.getElementById("vendaFrete").value);

    if (taxa === null || frete === null) {
      alertaErro.textContent = "Taxa e frete não podem ser negativos.";
      alertaErro.style.display = "block";
      return;
    }

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

    let avisoTaxaFrete = false;
    try {
      if (btnConfirmar) {
        btnConfirmar.disabled = true;
        btnConfirmar.textContent = "Registrando...";
      }

      if (estado.modoDemo) {
        prod.estoque = Math.max(0, Number(prod.estoque) - qtd);
        const novaVendaDemo = {
          id: "v-" + Date.now(),
          produto_id: prod.id,
          nome_produto_snapshot: prod.nome,
          quantidade: qtd,
          valor_unitario: Number((valorTotal / qtd).toFixed(2)),
          valor_total: Number(valorTotal.toFixed(2)),
          custo_unitario_snapshot: Number(prod.preco_custo) || 0,
          abaixo_preco_minimo: abaixoDoMinimo,
          observacao,
          taxa,
          frete,
          data_venda: new Date().toISOString()
        };
        estado.vendasMes.unshift(novaVendaDemo);
        estado.todasVendas.unshift(novaVendaDemo);
      } else {
        // Chama a função transacional segura criada no setup.sql
        const { data, error } = await supabaseClient.rpc("registrar_venda_admin", {
          p_produto_id: prod.id,
          p_quantidade: qtd,
          p_valor_total: Number(valorTotal.toFixed(2)),
          p_observacao: observacao
        });

        if (error) throw error;

        // Taxa e frete são gravados na venda recém-criada
        if ((taxa > 0 || frete > 0) && data && data.venda_id) {
          const { error: erroTaxa } = await supabaseClient
            .from("vendas")
            .update({ taxa, frete })
            .eq("id", data.venda_id);
          if (erroTaxa) {
            console.error("Erro ao salvar taxa/frete:", erroTaxa);
            avisoTaxaFrete = true;
          }
        }
      }

      fecharModalVenda();
      await carregarDadosAdmin();
      mostrarToast(
        avisoTaxaFrete
          ? "Venda registrada, mas a taxa/frete não foi salva. Ajuste no Relatório Mensal."
          : "Venda registrada e estoque atualizado!"
      );
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
      linha.style.alignItems = "flex-start";

      const divInfo = document.createElement("div");
      divInfo.style.flex = "1";

      if (cat.arquivada) linha.style.opacity = "0.6";

      const span = document.createElement("div");
      span.style.fontWeight = "800";
      span.textContent = cat.arquivada ? `📦 ${cat.nome} (arquivada)` : cat.nome;
      divInfo.appendChild(span);

      const qtdProdutos = estado.produtos.filter(
        (p) => String(p.categoria_id) === String(cat.id)
      ).length;
      const contagem = document.createElement("div");
      contagem.style.fontSize = "0.78rem";
      contagem.style.color = "#57534e";
      contagem.textContent = cat.arquivada
        ? `${qtdProdutos} ${qtdProdutos === 1 ? "produto" : "produtos"} • oculta na vitrine`
        : `${qtdProdutos} ${qtdProdutos === 1 ? "produto" : "produtos"}`;
      divInfo.appendChild(contagem);

      const subs =
        Array.isArray(cat.subcategorias) && cat.subcategorias.length > 0
          ? cat.subcategorias
          : CATEGORIAS_ORGANIZADAS_PADRAO.find((p) => p.slug === cat.slug)?.subcategorias || [];

      const arquivadas = Array.isArray(cat.subcategorias_arquivadas)
        ? cat.subcategorias_arquivadas
        : [];

      const subTitulo = document.createElement("div");
      subTitulo.style.cssText = "font-size: 0.78rem; color: #57534e; margin-top: 6px;";
      subTitulo.textContent =
        subs.length > 0
          ? "Subcategorias (toque no nome para arquivar, ✏️ para editar ou ✕ para excluir):"
          : "Nenhuma subcategoria ainda. Adicione abaixo:";
      divInfo.appendChild(subTitulo);

      if (subs.length > 0) {
        const subLista = document.createElement("div");
        subLista.style.cssText = "display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px;";
        subs.forEach((sub) => {
          const estaArquivada = arquivadas.includes(sub);

          const grupoChip = document.createElement("div");
          grupoChip.className = "chip-subcategoria-grupo";

          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "chip-subcategoria" + (estaArquivada ? " arquivada" : "");
          chip.textContent = estaArquivada ? `📦 ${sub}` : sub;
          chip.title = estaArquivada
            ? "Arquivada (oculta na vitrine). Clique para desarquivar."
            : "Clique para arquivar (ocultar da vitrine sem apagar).";
          chip.addEventListener("click", () => alternarArquivamentoSubcategoria(cat, sub));

          const btnEditSub = document.createElement("button");
          btnEditSub.type = "button";
          btnEditSub.className = "btn-acao-sub";
          btnEditSub.textContent = "✏️";
          btnEditSub.title = `Editar nome da subcategoria "${sub}"`;
          btnEditSub.addEventListener("click", () => editarSubcategoria(cat, sub, subs));

          const btnDelSub = document.createElement("button");
          btnDelSub.type = "button";
          btnDelSub.className = "btn-acao-sub excluir";
          btnDelSub.textContent = "✕";
          btnDelSub.title = `Excluir subcategoria "${sub}"`;
          btnDelSub.addEventListener("click", () => excluirSubcategoria(cat, sub, subs));

          grupoChip.appendChild(chip);
          grupoChip.appendChild(btnEditSub);
          grupoChip.appendChild(btnDelSub);
          subLista.appendChild(grupoChip);
        });
        divInfo.appendChild(subLista);
      }

      // Linha rápida para adicionar nova subcategoria nesta categoria
      const linhaNovaSub = document.createElement("div");
      linhaNovaSub.className = "linha-nova-sub-admin";
      const inputNovaSub = document.createElement("input");
      inputNovaSub.type = "text";
      inputNovaSub.placeholder = "Nova subcategoria...";
      inputNovaSub.maxLength = 50;
      const btnAddSub = document.createElement("button");
      btnAddSub.type = "button";
      btnAddSub.textContent = "➕ Adicionar Sub";
      btnAddSub.addEventListener("click", () => {
        adicionarSubcategoriaNaCategoria(cat, inputNovaSub.value, subs);
        inputNovaSub.value = "";
      });
      inputNovaSub.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          adicionarSubcategoriaNaCategoria(cat, inputNovaSub.value, subs);
          inputNovaSub.value = "";
        }
      });
      linhaNovaSub.appendChild(inputNovaSub);
      linhaNovaSub.appendChild(btnAddSub);
      divInfo.appendChild(linhaNovaSub);

      const btnEditarCat = document.createElement("button");
      btnEditarCat.type = "button";
      btnEditarCat.className = "btn-secundario-admin";
      btnEditarCat.style.minHeight = "34px";
      btnEditarCat.style.padding = "0 10px";
      btnEditarCat.textContent = "✏️ Editar";
      btnEditarCat.title = "Renomear esta categoria";
      btnEditarCat.addEventListener("click", () => editarNomeCategoria(cat));

      const btnDel = document.createElement("button");
      btnDel.type = "button";
      btnDel.className = "btn-secundario-admin";
      btnDel.style.minHeight = "34px";
      btnDel.style.padding = "0 10px";
      btnDel.textContent = "Excluir";
      btnDel.addEventListener("click", () => excluirCategoria(cat));

      const btnArquivar = document.createElement("button");
      btnArquivar.type = "button";
      btnArquivar.className = "btn-secundario-admin";
      btnArquivar.style.minHeight = "34px";
      btnArquivar.style.padding = "0 10px";
      btnArquivar.textContent = cat.arquivada ? "📤 Desarquivar" : "📦 Arquivar";
      btnArquivar.title = cat.arquivada
        ? "Voltar a mostrar esta categoria na vitrine"
        : "Esconder esta categoria (e os produtos dela) da vitrine sem apagar";
      btnArquivar.addEventListener("click", () => alternarArquivamentoCategoria(cat, qtdProdutos));

      const botoes = document.createElement("div");
      botoes.style.cssText = "display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end;";
      botoes.appendChild(btnEditarCat);
      botoes.appendChild(btnArquivar);
      botoes.appendChild(btnDel);

      linha.appendChild(divInfo);
      linha.appendChild(botoes);
      container.appendChild(linha);
    });
  }

  async function editarNomeCategoria(cat) {
    const novoNomeBruto = window.prompt("Novo nome para a categoria:", cat.nome || "");
    if (novoNomeBruto === null) return;
    const novoNome = limparTexto(novoNomeBruto, 80);
    if (!novoNome || novoNome === cat.nome) return;

    const novoSlug = gerarSlug(novoNome) || cat.slug;

    try {
      if (!estado.modoDemo) {
        const { error } = await supabaseClient
          .from("categorias")
          .update({ nome: novoNome, slug: novoSlug })
          .eq("id", cat.id);
        if (error) throw error;
      }
      cat.nome = novoNome;
      cat.slug = novoSlug;
      await carregarDadosAdmin();
      renderizarListaCategoriasModal();
      mostrarToast("Categoria renomeada com sucesso!");
    } catch (erro) {
      console.error("Erro ao editar categoria:", erro);
      mostrarToast("Não foi possível renomear a categoria.");
    }
  }

  async function adicionarSubcategoriaNaCategoria(cat, nomeSubBruto, subsAtuais) {
    const novaSub = limparTexto(nomeSubBruto, 50);
    if (!novaSub) {
      mostrarToast("Digite o nome da nova subcategoria.");
      return;
    }
    const listaAtual = Array.isArray(subsAtuais) ? [...subsAtuais] : [];
    if (listaAtual.some((s) => s.toLowerCase() === novaSub.toLowerCase())) {
      mostrarToast("Esta subcategoria já existe nesta categoria.");
      return;
    }
    const novasSubs = [...listaAtual, novaSub];

    try {
      if (!estado.modoDemo) {
        const { error } = await supabaseClient
          .from("categorias")
          .update({ subcategorias: novasSubs })
          .eq("id", cat.id);
        if (error) throw error;
      }
      cat.subcategorias = novasSubs;
      renderizarListaCategoriasModal();
      atualizarSelectsCategorias();
      mostrarToast(`Subcategoria "${novaSub}" adicionada em ${cat.nome}!`);
    } catch (erro) {
      console.error("Erro ao adicionar subcategoria:", erro);
      mostrarToast("Não foi possível salvar a nova subcategoria.");
    }
  }

  async function editarSubcategoria(cat, subAntiga, subsAtuais) {
    const novoNomeBruto = window.prompt(
      `Editar nome da subcategoria "${subAntiga}" em ${cat.nome}:`,
      subAntiga
    );
    if (novoNomeBruto === null) return;
    const novaSub = limparTexto(novoNomeBruto, 50);
    if (!novaSub || novaSub === subAntiga) return;

    const novasSubs = (Array.isArray(subsAtuais) ? subsAtuais : []).map((s) =>
      s === subAntiga ? novaSub : s
    );
    const arquivadas = Array.isArray(cat.subcategorias_arquivadas)
      ? cat.subcategorias_arquivadas.map((s) => (s === subAntiga ? novaSub : s))
      : [];

    try {
      if (!estado.modoDemo) {
        const { error } = await supabaseClient
          .from("categorias")
          .update({ subcategorias: novasSubs, subcategorias_arquivadas: arquivadas })
          .eq("id", cat.id);
        if (error) throw error;

        // Atualiza produtos que usavam o nome antigo da subcategoria
        await supabaseClient
          .from("produtos")
          .update({ subcategoria: novaSub })
          .eq("categoria_id", cat.id)
          .eq("subcategoria", subAntiga);
      }
      cat.subcategorias = novasSubs;
      cat.subcategorias_arquivadas = arquivadas;
      await carregarDadosAdmin();
      renderizarListaCategoriasModal();
      mostrarToast(`Subcategoria atualizada para "${novaSub}"!`);
    } catch (erro) {
      console.error("Erro ao editar subcategoria:", erro);
      mostrarToast("Não foi possível renomear a subcategoria.");
    }
  }

  async function excluirSubcategoria(cat, subAlvo, subsAtuais) {
    if (!window.confirm(`Deseja remover a subcategoria "${subAlvo}" de "${cat.nome}"?`)) return;
    const novasSubs = (Array.isArray(subsAtuais) ? subsAtuais : []).filter((s) => s !== subAlvo);
    const arquivadas = Array.isArray(cat.subcategorias_arquivadas)
      ? cat.subcategorias_arquivadas.filter((s) => s !== subAlvo)
      : [];

    try {
      if (!estado.modoDemo) {
        const { error } = await supabaseClient
          .from("categorias")
          .update({ subcategorias: novasSubs, subcategorias_arquivadas: arquivadas })
          .eq("id", cat.id);
        if (error) throw error;
      }
      cat.subcategorias = novasSubs;
      cat.subcategorias_arquivadas = arquivadas;
      renderizarListaCategoriasModal();
      atualizarSelectsCategorias();
      mostrarToast(`Subcategoria "${subAlvo}" removida.`);
    } catch (erro) {
      console.error("Erro ao excluir subcategoria:", erro);
      mostrarToast("Não foi possível excluir a subcategoria.");
    }
  }

  async function alternarArquivamentoSubcategoria(cat, sub) {
    const atuais = Array.isArray(cat.subcategorias_arquivadas) ? cat.subcategorias_arquivadas : [];
    const arquivar = !atuais.includes(sub);
    const qtdProdutos = estado.produtos.filter(
      (p) => String(p.categoria_id) === String(cat.id) && String(p.subcategoria || "").trim() === sub
    ).length;

    if (
      arquivar &&
      qtdProdutos > 0 &&
      !window.confirm(
        `A subcategoria "${sub}" tem ${qtdProdutos} ${
          qtdProdutos === 1 ? "produto" : "produtos"
        }. Ao arquivar, eles também deixam de aparecer na vitrine (nada é apagado). Continuar?`
      )
    ) {
      return;
    }

    const novas = arquivar ? [...atuais, sub] : atuais.filter((s) => s !== sub);

    try {
      if (!estado.modoDemo) {
        const { error } = await supabaseClient
          .from("categorias")
          .update({ subcategorias_arquivadas: novas })
          .eq("id", cat.id);
        if (error) throw error;
      }
      cat.subcategorias_arquivadas = novas;
      renderizarListaCategoriasModal();
      mostrarToast(
        arquivar
          ? `Subcategoria "${sub}" arquivada. Ela não aparece mais na vitrine.`
          : `Subcategoria "${sub}" voltou para a vitrine.`
      );
    } catch (erro) {
      console.error("Erro ao arquivar subcategoria:", erro);
      mostrarToast("Não foi possível arquivar. Verifique se o SQL de atualização foi executado no Supabase.");
    }
  }

  async function alternarArquivamentoCategoria(cat, qtdProdutos) {
    const arquivar = !cat.arquivada;
    if (
      arquivar &&
      qtdProdutos > 0 &&
      !window.confirm(
        `A categoria "${cat.nome}" tem ${qtdProdutos} ${
          qtdProdutos === 1 ? "produto" : "produtos"
        }. Ao arquivar, eles também deixam de aparecer na vitrine (nada é apagado). Continuar?`
      )
    ) {
      return;
    }

    try {
      if (!estado.modoDemo) {
        const { error } = await supabaseClient
          .from("categorias")
          .update({ arquivada: arquivar })
          .eq("id", cat.id);
        if (error) throw error;
      }
      cat.arquivada = arquivar;
      renderizarListaCategoriasModal();
      mostrarToast(
        arquivar
          ? `Categoria "${cat.nome}" arquivada. Ela não aparece mais na vitrine.`
          : `Categoria "${cat.nome}" voltou para a vitrine.`
      );
    } catch (erro) {
      console.error("Erro ao arquivar categoria:", erro);
      mostrarToast("Não foi possível arquivar. Verifique se o SQL de atualização foi executado no Supabase.");
    }
  }

  async function adicionarCategoriaSubmit(evento) {
    evento.preventDefault();
    const input = document.getElementById("inputNomeNovaCategoria");
    const inputSubs = document.getElementById("inputSubcategoriasNova");
    const nome = limparTexto(input.value, 80);
    if (!nome) return;

    const subcategorias = String(inputSubs?.value || "")
      .split(",")
      .map((s) => limparTexto(s, 50))
      .filter(Boolean);

    const slug = gerarSlug(nome) || "cat-" + Date.now();

    try {
      if (estado.modoDemo) {
        estado.categorias.push({
          id: "cat-" + Date.now(),
          nome,
          slug,
          subcategorias,
          ordem: estado.categorias.length + 1
        });
      } else {
        const payload = { nome, slug, ordem: estado.categorias.length + 1 };
        if (subcategorias.length > 0) payload.subcategorias = subcategorias;

        let { error } = await supabaseClient.from("categorias").insert([payload]);
        // Fallback caso a coluna subcategorias ainda não tenha sido adicionada no banco via SQL
        if (error && String(error.message || "").includes("subcategorias")) {
          const semSub = { nome, slug, ordem: estado.categorias.length + 1 };
          const retry = await supabaseClient.from("categorias").insert([semSub]);
          error = retry.error;
        }
        if (error) throw error;
      }

      input.value = "";
      if (inputSubs) inputSubs.value = "";
      await carregarDadosAdmin();
      renderizarListaCategoriasModal();
      mostrarToast("Categoria criada com sucesso!");
    } catch (erro) {
      console.error("Erro ao criar categoria:", erro);
      mostrarToast("Não foi possível criar a categoria.");
    }
  }

  async function aplicarCategoriasOrganizadasPadrao() {
    try {
      for (const item of CATEGORIAS_ORGANIZADAS_PADRAO) {
        const existente = estado.categorias.find((c) => c.slug === item.slug);
        if (!existente) {
          let { error } = await supabaseClient.from("categorias").insert([
            {
              nome: item.nome,
              slug: item.slug,
              subcategorias: item.subcategorias,
              ordem: item.ordem
            }
          ]);
          if (error && String(error.message || "").includes("subcategorias")) {
            await supabaseClient.from("categorias").insert([
              {
                nome: item.nome,
                slug: item.slug,
                ordem: item.ordem
              }
            ]);
          }
        }
      }
      await carregarDadosAdmin();
      renderizarListaCategoriasModal();
      mostrarToast("Categorias e subcategorias organizadas aplicadas!");
    } catch (erro) {
      console.error("Erro ao aplicar categorias padrão:", erro);
      mostrarToast("Erro ao atualizar categorias.");
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
  // 9A. ÁREAS DE ENTREGA (BAIRROS/REGIÕES E VALOR DO FRETE)
  // ==========================================================================

  async function carregarAreasEntrega() {
    if (estado.modoDemo) return;
    const { data, error } = await supabaseClient
      .from("areas_entrega")
      .select("*")
      .order("ordem", { ascending: true })
      .order("nome", { ascending: true });
    if (error) throw error;
    estado.areasEntrega = data || [];
  }

  async function abrirModalEntregas() {
    const modal = document.getElementById("modalEntregas");
    if (modal) {
      modal.classList.add("aberto");
      modal.setAttribute("aria-hidden", "false");
    }
    try {
      await carregarAreasEntrega();
    } catch (erro) {
      console.error("Erro ao carregar áreas de entrega:", erro);
      mostrarToast("Não foi possível carregar as áreas. Verifique se o SQL de atualização foi executado no Supabase.");
    }
    renderizarListaAreasEntrega();
  }

  function fecharModalEntregas() {
    const modal = document.getElementById("modalEntregas");
    if (modal) {
      modal.classList.remove("aberto");
      modal.setAttribute("aria-hidden", "true");
    }
  }

  function renderizarListaAreasEntrega() {
    const container = document.getElementById("listaAreasEntrega");
    if (!container) return;
    container.textContent = "";

    if (estado.areasEntrega.length === 0) {
      const vazio = document.createElement("div");
      vazio.className = "estado-lista";
      vazio.textContent = "Nenhuma área cadastrada ainda. Enquanto a lista estiver vazia, a entrega é combinada pelo WhatsApp.";
      container.appendChild(vazio);
      return;
    }

    estado.areasEntrega.forEach((area) => {
      const linha = document.createElement("div");
      linha.className = "carrinho-item";
      linha.style.cssText = "flex-direction: column; align-items: stretch; gap: 8px;";
      if (!area.ativa) linha.style.opacity = "0.6";

      const inputNome = document.createElement("input");
      inputNome.type = "text";
      inputNome.className = "form-input";
      inputNome.maxLength = 80;
      inputNome.value = area.nome || "";
      inputNome.style.fontWeight = "700";

      const grade = document.createElement("div");
      grade.style.cssText = "display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 0.8rem;";

      const criarCampoValor = (rotulo, valor, placeholder) => {
        const label = document.createElement("label");
        label.style.cssText = "display: flex; align-items: center; gap: 4px;";
        label.textContent = rotulo;
        const input = document.createElement("input");
        input.type = "number";
        input.min = "0";
        input.step = "0.01";
        input.placeholder = placeholder;
        input.className = "form-input";
        input.style.cssText = "width: 96px; min-height: 34px; padding: 2px 6px; font-size: 0.85rem;";
        input.value = valor !== null && valor !== undefined ? Number(valor).toFixed(2) : "";
        label.appendChild(input);
        grade.appendChild(label);
        return input;
      };

      const inputValor = criarCampoValor("Frete R$", area.valor, "0,00");
      const inputGratis = criarCampoValor("Grátis acima de R$", area.gratis_acima, "—");

      const labelAtiva = document.createElement("label");
      labelAtiva.className = "checkbox-label";
      const checkAtiva = document.createElement("input");
      checkAtiva.type = "checkbox";
      checkAtiva.checked = Boolean(area.ativa);
      const spanAtiva = document.createElement("span");
      spanAtiva.textContent = "Ativa no site";
      labelAtiva.appendChild(checkAtiva);
      labelAtiva.appendChild(spanAtiva);
      grade.appendChild(labelAtiva);

      const btnSalvar = document.createElement("button");
      btnSalvar.type = "button";
      btnSalvar.className = "btn-secundario-admin";
      btnSalvar.style.cssText = "min-height: 34px; padding: 0 10px;";
      btnSalvar.textContent = "💾 Salvar";
      btnSalvar.addEventListener("click", () =>
        salvarAreaEntrega(area, {
          nome: inputNome.value,
          valor: inputValor.value,
          gratis: inputGratis.value,
          ativa: checkAtiva.checked
        })
      );

      const btnExcluir = document.createElement("button");
      btnExcluir.type = "button";
      btnExcluir.className = "btn-secundario-admin";
      btnExcluir.style.cssText = "min-height: 34px; padding: 0 10px; color: #991b1b; border-color: #fca5a5;";
      btnExcluir.textContent = "Excluir";
      btnExcluir.addEventListener("click", () => excluirAreaEntrega(area));

      grade.appendChild(btnSalvar);
      grade.appendChild(btnExcluir);

      linha.appendChild(inputNome);
      linha.appendChild(grade);
      container.appendChild(linha);
    });
  }

  // Valida os campos de uma área; retorna null (com aviso) se algo estiver errado
  function montarDadosAreaEntrega(nomeTexto, valorTexto, gratisTexto) {
    const nome = limparTexto(nomeTexto, 80);
    const valor = parseFloat(valorTexto);
    const gratis = gratisTexto === "" ? null : parseFloat(gratisTexto);

    if (!nome) {
      mostrarToast("Informe o nome do bairro ou região.");
      return null;
    }
    if (isNaN(valor) || valor < 0) {
      mostrarToast("Informe um valor de frete válido (pode ser 0).");
      return null;
    }
    if (gratis !== null && (isNaN(gratis) || gratis < 0)) {
      mostrarToast("O valor para frete grátis não pode ser negativo.");
      return null;
    }
    return {
      nome,
      valor: Number(valor.toFixed(2)),
      gratis_acima: gratis !== null ? Number(gratis.toFixed(2)) : null
    };
  }

  async function adicionarAreaEntregaSubmit(evento) {
    evento.preventDefault();
    const inputNome = document.getElementById("inputNomeAreaEntrega");
    const inputValor = document.getElementById("inputValorAreaEntrega");
    const inputGratis = document.getElementById("inputGratisAreaEntrega");

    const dados = montarDadosAreaEntrega(inputNome.value, inputValor.value, inputGratis.value);
    if (!dados) return;
    const novaArea = { ...dados, ativa: true, ordem: estado.areasEntrega.length + 1 };

    try {
      if (estado.modoDemo) {
        estado.areasEntrega.push({ id: "area-" + Date.now(), ...novaArea });
      } else {
        const { error } = await supabaseClient.from("areas_entrega").insert([novaArea]);
        if (error) throw error;
        await carregarAreasEntrega();
      }
      inputNome.value = "";
      inputValor.value = "";
      inputGratis.value = "";
      renderizarListaAreasEntrega();
      mostrarToast("Área de entrega adicionada!");
    } catch (erro) {
      console.error("Erro ao adicionar área de entrega:", erro);
      mostrarToast("Não foi possível adicionar. Verifique se o SQL de atualização foi executado no Supabase.");
    }
  }

  async function salvarAreaEntrega(area, campos) {
    const dados = montarDadosAreaEntrega(campos.nome, campos.valor, campos.gratis);
    if (!dados) return;
    const atualizacao = { ...dados, ativa: campos.ativa };

    try {
      if (!estado.modoDemo) {
        const { error } = await supabaseClient
          .from("areas_entrega")
          .update(atualizacao)
          .eq("id", area.id);
        if (error) throw error;
      }
      Object.assign(area, atualizacao);
      renderizarListaAreasEntrega();
      mostrarToast("Área de entrega salva!");
    } catch (erro) {
      console.error("Erro ao salvar área de entrega:", erro);
      mostrarToast("Não foi possível salvar a área de entrega.");
    }
  }

  async function excluirAreaEntrega(area) {
    if (!window.confirm(`Excluir a área de entrega "${area.nome}"?`)) return;
    try {
      if (!estado.modoDemo) {
        const { error } = await supabaseClient.from("areas_entrega").delete().eq("id", area.id);
        if (error) throw error;
      }
      estado.areasEntrega = estado.areasEntrega.filter((a) => a.id !== area.id);
      renderizarListaAreasEntrega();
      mostrarToast("Área de entrega excluída.");
    } catch (erro) {
      console.error("Erro ao excluir área de entrega:", erro);
      mostrarToast("Não foi possível excluir a área de entrega.");
    }
  }

  // ==========================================================================
  // 9B. RELATÓRIO FINANCEIRO MENSAL (ENTRADAS, SAÍDAS E EXPORTAÇÃO EXCEL)
  // ==========================================================================

  function obterChaveAnoMes(dataIso) {
    const d = dataIso ? new Date(dataIso) : new Date();
    if (isNaN(d.getTime())) return "";
    const ano = d.getFullYear();
    const mes = String(d.getMonth() + 1).padStart(2, "0");
    return `${ano}-${mes}`;
  }

  function formatarRotuloAnoMes(chaveAnoMes) {
    if (chaveAnoMes === "todos") return "Todos os meses (Histórico Completo)";
    const partes = String(chaveAnoMes).split("-");
    if (partes.length !== 2) return chaveAnoMes;
    const nomesMeses = [
      "Janeiro",
      "Fevereiro",
      "Março",
      "Abril",
      "Maio",
      "Junho",
      "Julho",
      "Agosto",
      "Setembro",
      "Outubro",
      "Novembro",
      "Dezembro"
    ];
    const idx = parseInt(partes[1], 10) - 1;
    return `${nomesMeses[idx] || partes[1]} de ${partes[0]}`;
  }

  function formatarDataHoraBR(dataIso) {
    if (!dataIso) return "";
    const d = new Date(dataIso);
    if (isNaN(d.getTime())) return String(dataIso);
    return d.toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function escaparCelulaCSV(valor) {
    const texto = String(valor ?? "")
      .replace(/\r?\n|\r/g, " ")
      .replace(/"/g, '""')
      .trim();
    return `"${texto}"`;
  }

  function formatarNumeroExcelBR(valor) {
    const num = Number(valor) || 0;
    return num.toFixed(2).replace(".", ",");
  }

  // Lê um campo de valor opcional: vazio = 0, negativo/inválido = null
  function lerValorMonetario(texto) {
    if (texto === "" || texto === null || texto === undefined) return 0;
    const num = parseFloat(texto);
    if (isNaN(num) || num < 0) return null;
    return Number(num.toFixed(2));
  }

  function obterTaxaVenda(v) {
    return Number(v.taxa) || 0;
  }

  function obterFreteVenda(v) {
    return Number(v.frete) || 0;
  }

  function calcularLucroVenda(v) {
    return (
      (Number(v.valor_total) || 0) -
      (Number(v.custo_unitario_snapshot) || 0) * (Number(v.quantidade) || 1) -
      obterTaxaVenda(v) -
      obterFreteVenda(v)
    );
  }

  async function salvarTaxaFreteVenda(venda, taxa, frete) {
    if (!estado.modoDemo) {
      const { error } = await supabaseClient
        .from("vendas")
        .update({ taxa, frete })
        .eq("id", venda.id);
      if (error) throw error;
    }
    venda.taxa = taxa;
    venda.frete = frete;
  }

  function obterVendasFiltradasPorMes(chaveMes) {
    const listaBase =
      Array.isArray(estado.todasVendas) && estado.todasVendas.length > 0
        ? estado.todasVendas
        : estado.vendasMes;
    if (!chaveMes || chaveMes === "todos") return listaBase;
    return listaBase.filter((v) => obterChaveAnoMes(v.data_venda) === chaveMes);
  }

  function popularSelectMesesRelatorio() {
    const select = document.getElementById("selectMesRelatorio");
    if (!select) return;

    const mesAtual = obterChaveAnoMes(new Date().toISOString());
    const conjuntoMeses = new Set([mesAtual]);

    (estado.todasVendas || []).forEach((v) => {
      const ch = obterChaveAnoMes(v.data_venda);
      if (ch) conjuntoMeses.add(ch);
    });

    const mesesOrdenados = Array.from(conjuntoMeses).sort().reverse();
    if (!estado.mesRelatorioSelecionado) {
      estado.mesRelatorioSelecionado = mesAtual;
    }

    select.textContent = "";
    mesesOrdenados.forEach((ch) => {
      const opt = document.createElement("option");
      opt.value = ch;
      opt.textContent = formatarRotuloAnoMes(ch);
      select.appendChild(opt);
    });

    const optTodos = document.createElement("option");
    optTodos.value = "todos";
    optTodos.textContent = "Todos os meses (Histórico Completo)";
    select.appendChild(optTodos);

    select.value = estado.mesRelatorioSelecionado;
  }

  function atualizarPainelRelatorioMensal() {
    const chaveMes = estado.mesRelatorioSelecionado || obterChaveAnoMes(new Date().toISOString());
    const vendasPeriodo = obterVendasFiltradasPorMes(chaveMes);

    // 1. Entrada / Posição atual em estoque (custo total investido)
    let qtdTotalEstoque = 0;
    let custoTotalEstoque = 0;
    estado.produtos.forEach((p) => {
      const qtd = Math.max(0, Number(p.estoque) || 0);
      const custo = Number(p.preco_custo) || 0;
      qtdTotalEstoque += qtd;
      custoTotalEstoque += qtd * custo;
    });

    // 2. Saídas / Vendas no mês selecionado
    let qtdUnidadesVendidas = 0;
    let receitaTotalSaidas = 0;
    let custoTotalSaidas = 0;
    let totalTaxas = 0;
    let totalFretes = 0;

    vendasPeriodo.forEach((v) => {
      const qtd = Number(v.quantidade) || 1;
      const total = Number(v.valor_total) || 0;
      const custoUnit = Number(v.custo_unitario_snapshot) || 0;
      qtdUnidadesVendidas += qtd;
      receitaTotalSaidas += total;
      custoTotalSaidas += qtd * custoUnit;
      totalTaxas += obterTaxaVenda(v);
      totalFretes += obterFreteVenda(v);
    });

    const lucroLiquido = receitaTotalSaidas - custoTotalSaidas - totalTaxas - totalFretes;

    const elEntradaValor = document.getElementById("relEntradaValor");
    const elEntradaQtd = document.getElementById("relEntradaQtd");
    const elSaidaValor = document.getElementById("relSaidaValor");
    const elSaidaQtd = document.getElementById("relSaidaQtd");
    const elCustoVendas = document.getElementById("relCustoVendasValor");
    const elLucro = document.getElementById("relLucroLiquidoValor");

    if (elEntradaValor) elEntradaValor.textContent = formatarMoeda(custoTotalEstoque);
    if (elEntradaQtd) {
      elEntradaQtd.textContent = `${qtdTotalEstoque} ${
        qtdTotalEstoque === 1 ? "unidade" : "unidades"
      } em estoque (preço de custo)`;
    }
    if (elSaidaValor) elSaidaValor.textContent = formatarMoeda(receitaTotalSaidas);
    if (elSaidaQtd) {
      elSaidaQtd.textContent = `${vendasPeriodo.length} ${
        vendasPeriodo.length === 1 ? "venda" : "vendas"
      } (${qtdUnidadesVendidas} un. vendidas)`;
    }
    if (elCustoVendas) elCustoVendas.textContent = formatarMoeda(custoTotalSaidas);
    const elTaxas = document.getElementById("relTaxasValor");
    const elFretes = document.getElementById("relFretesValor");
    if (elTaxas) elTaxas.textContent = formatarMoeda(totalTaxas);
    if (elFretes) elFretes.textContent = formatarMoeda(totalFretes);
    if (elLucro) elLucro.textContent = formatarMoeda(lucroLiquido);

    // Renderiza lista de saídas do período
    const containerLista = document.getElementById("listaVendasRelatorio");
    if (!containerLista) return;
    containerLista.textContent = "";

    if (vendasPeriodo.length === 0) {
      const vazio = document.createElement("div");
      vazio.className = "estado-lista";
      vazio.textContent = "Nenhuma venda registrada neste período.";
      containerLista.appendChild(vazio);
      return;
    }

    vendasPeriodo.forEach((v) => {
      const item = document.createElement("div");
      item.className = "carrinho-item";

      const info = document.createElement("div");
      info.style.flex = "1";

      const titulo = document.createElement("div");
      titulo.style.fontWeight = "600";
      titulo.textContent = `${v.quantidade}x ${v.nome_produto_snapshot}`;

      const sub = document.createElement("div");
      sub.style.fontSize = "0.78rem";
      sub.style.color = "#57534e";
      sub.textContent = `${formatarDataHoraBR(v.data_venda)} • Lucro: ${formatarMoeda(
        calcularLucroVenda(v)
      )}${v.observacao ? ` • Obs.: ${v.observacao}` : ""}`;

      // Campos de taxa e frete editáveis direto no relatório
      const linhaTaxaFrete = document.createElement("div");
      linhaTaxaFrete.style.cssText =
        "display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 6px; font-size: 0.78rem;";

      const criarCampo = (rotulo, valor) => {
        const label = document.createElement("label");
        label.style.cssText = "display: flex; align-items: center; gap: 4px;";
        label.textContent = rotulo;
        const input = document.createElement("input");
        input.type = "number";
        input.min = "0";
        input.step = "0.01";
        input.placeholder = "0,00";
        input.className = "form-input";
        input.style.cssText = "width: 84px; min-height: 30px; padding: 2px 6px; font-size: 0.8rem;";
        input.value = valor > 0 ? valor.toFixed(2) : "";
        label.appendChild(input);
        linhaTaxaFrete.appendChild(label);
        return input;
      };

      const inputTaxa = criarCampo("💳 Taxa R$", obterTaxaVenda(v));
      const inputFrete = criarCampo("🚚 Frete R$", obterFreteVenda(v));

      const btnSalvar = document.createElement("button");
      btnSalvar.type = "button";
      btnSalvar.className = "btn-secundario-admin";
      btnSalvar.style.cssText = "min-height: 30px; padding: 0 10px; font-size: 0.78rem;";
      btnSalvar.textContent = "💾";
      btnSalvar.title = "Salvar taxa e frete desta venda";
      btnSalvar.addEventListener("click", async () => {
        const taxa = lerValorMonetario(inputTaxa.value);
        const frete = lerValorMonetario(inputFrete.value);
        if (taxa === null || frete === null) {
          mostrarToast("Taxa e frete não podem ser negativos.");
          return;
        }
        try {
          btnSalvar.disabled = true;
          await salvarTaxaFreteVenda(v, taxa, frete);
          atualizarPainelRelatorioMensal();
          mostrarToast("Taxa e frete salvos!");
        } catch (erro) {
          console.error("Erro ao salvar taxa/frete:", erro);
          mostrarToast("Erro ao salvar taxa/frete. Verifique se o SQL de atualização foi executado no Supabase.");
          btnSalvar.disabled = false;
        }
      });
      linhaTaxaFrete.appendChild(btnSalvar);

      info.appendChild(titulo);
      info.appendChild(sub);
      info.appendChild(linhaTaxaFrete);

      const valorDir = document.createElement("strong");
      valorDir.style.color = "#0f3d2e";
      valorDir.textContent = formatarMoeda(v.valor_total);

      item.appendChild(info);
      item.appendChild(valorDir);
      containerLista.appendChild(item);
    });
  }

  function abrirModalRelatorioMensal() {
    const modal = document.getElementById("modalRelatorioMensal");
    popularSelectMesesRelatorio();
    atualizarPainelRelatorioMensal();
    if (modal) {
      modal.classList.add("aberto");
      modal.setAttribute("aria-hidden", "false");
    }
  }

  function fecharModalRelatorioMensal() {
    const modal = document.getElementById("modalRelatorioMensal");
    if (modal) {
      modal.classList.remove("aberto");
      modal.setAttribute("aria-hidden", "true");
    }
  }

  function baixarArquivoCSV(nomeArquivo, linhasArray) {
    // BOM UTF-8 (\uFEFF) garante que o Excel no Windows reconheça acentos e colunas com ';'
    const conteudo = "\uFEFF" + linhasArray.join("\r\n");
    const blob = new Blob([conteudo], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = nomeArquivo;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function exportarPlanilhaExcelCompleta() {
    const chaveMes = estado.mesRelatorioSelecionado || obterChaveAnoMes(new Date().toISOString());
    const rotuloPeriodo = formatarRotuloAnoMes(chaveMes);
    const vendasPeriodo = obterVendasFiltradasPorMes(chaveMes);

    let qtdTotalEstoque = 0;
    let custoTotalEstoque = 0;
    let valorPotencialVendaEstoque = 0;

    estado.produtos.forEach((p) => {
      const qtd = Math.max(0, Number(p.estoque) || 0);
      const custo = Number(p.preco_custo) || 0;
      const venda = Number(p.preco_venda) || 0;
      qtdTotalEstoque += qtd;
      custoTotalEstoque += qtd * custo;
      valorPotencialVendaEstoque += qtd * venda;
    });

    let qtdVendidaMes = 0;
    let receitaBrutaMes = 0;
    let custoMercadoriasVendidasMes = 0;
    let taxasMes = 0;
    let fretesMes = 0;

    vendasPeriodo.forEach((v) => {
      const qtd = Number(v.quantidade) || 1;
      qtdVendidaMes += qtd;
      receitaBrutaMes += Number(v.valor_total) || 0;
      custoMercadoriasVendidasMes += (Number(v.custo_unitario_snapshot) || 0) * qtd;
      taxasMes += obterTaxaVenda(v);
      fretesMes += obterFreteVenda(v);
    });

    const lucroLiquidoMes = receitaBrutaMes - custoMercadoriasVendidasMes - taxasMes - fretesMes;

    const linhas = [];

    // BLOCO 1: RESUMO MENSAL DE ENTRADAS E SAÍDAS
    linhas.push([
      escaparCelulaCSV("RELATÓRIO FINANCEIRO E DE ESTOQUE - P&G PREÇOS JUSTOS"),
      escaparCelulaCSV(`Período: ${rotuloPeriodo}`),
      escaparCelulaCSV(`Gerado em: ${formatarDataHoraBR(new Date().toISOString())}`)
    ].join(";"));
    linhas.push("");

    linhas.push([
      escaparCelulaCSV("1. RESUMO DO PERÍODO (ENTRADAS, SAÍDAS E SALDO)"),
      escaparCelulaCSV("QUANTIDADE"),
      escaparCelulaCSV("VALOR (R$)")
    ].join(";"));

    linhas.push([
      escaparCelulaCSV("ENTRADA / ESTOQUE ATUAL (Custo Total Investido em Produtos)"),
      escaparCelulaCSV(`${qtdTotalEstoque} un.`),
      escaparCelulaCSV(formatarNumeroExcelBR(custoTotalEstoque))
    ].join(";"));

    linhas.push([
      escaparCelulaCSV("VALOR POTENCIAL DE VENDA DO ESTOQUE ATUAL"),
      escaparCelulaCSV(`${qtdTotalEstoque} un.`),
      escaparCelulaCSV(formatarNumeroExcelBR(valorPotencialVendaEstoque))
    ].join(";"));

    linhas.push([
      escaparCelulaCSV("SAÍDAS / VENDAS REALIZADAS NO PERÍODO (Receita Bruta)"),
      escaparCelulaCSV(`${vendasPeriodo.length} vendas (${qtdVendidaMes} un.)`),
      escaparCelulaCSV(formatarNumeroExcelBR(receitaBrutaMes))
    ].join(";"));

    linhas.push([
      escaparCelulaCSV("CUSTO DAS MERCADORIAS VENDIDAS NO PERÍODO (CMV)"),
      escaparCelulaCSV(`${qtdVendidaMes} un.`),
      escaparCelulaCSV(formatarNumeroExcelBR(custoMercadoriasVendidasMes))
    ].join(";"));

    linhas.push([
      escaparCelulaCSV("TAXAS NO PERÍODO (Maquininha, Pix, etc.)"),
      escaparCelulaCSV("-"),
      escaparCelulaCSV(formatarNumeroExcelBR(taxasMes))
    ].join(";"));

    linhas.push([
      escaparCelulaCSV("FRETES NO PERÍODO (Entregas)"),
      escaparCelulaCSV("-"),
      escaparCelulaCSV(formatarNumeroExcelBR(fretesMes))
    ].join(";"));

    linhas.push([
      escaparCelulaCSV("LUCRO LÍQUIDO DO PERÍODO (Receita - Custo - Taxas - Fretes)"),
      escaparCelulaCSV("-"),
      escaparCelulaCSV(formatarNumeroExcelBR(lucroLiquidoMes))
    ].join(";"));
    linhas.push("");

    // BLOCO 2: SAÍDAS DETALHADAS (VENDAS)
    linhas.push([
      escaparCelulaCSV("2. SAÍDAS DETALHADAS (HISTÓRICO DE VENDAS DO PERÍODO)")
    ].join(";"));
    linhas.push([
      escaparCelulaCSV("Data e Hora"),
      escaparCelulaCSV("Produto"),
      escaparCelulaCSV("Quantidade Vendida"),
      escaparCelulaCSV("Valor Unitário Vendido (R$)"),
      escaparCelulaCSV("Custo Unitário (R$)"),
      escaparCelulaCSV("Valor Total Recebido (R$)"),
      escaparCelulaCSV("Custo Total da Venda (R$)"),
      escaparCelulaCSV("Taxa (R$)"),
      escaparCelulaCSV("Frete (R$)"),
      escaparCelulaCSV("Lucro Líquido da Venda (R$)"),
      escaparCelulaCSV("Abaixo do Preço Mínimo?"),
      escaparCelulaCSV("Observação")
    ].join(";"));

    vendasPeriodo.forEach((v) => {
      const qtd = Number(v.quantidade) || 1;
      const totalVenda = Number(v.valor_total) || 0;
      const custoUnit = Number(v.custo_unitario_snapshot) || 0;
      const custoTotal = custoUnit * qtd;
      const lucro = calcularLucroVenda(v);

      linhas.push([
        escaparCelulaCSV(formatarDataHoraBR(v.data_venda)),
        escaparCelulaCSV(v.nome_produto_snapshot),
        escaparCelulaCSV(qtd),
        escaparCelulaCSV(formatarNumeroExcelBR(v.valor_unitario)),
        escaparCelulaCSV(formatarNumeroExcelBR(custoUnit)),
        escaparCelulaCSV(formatarNumeroExcelBR(totalVenda)),
        escaparCelulaCSV(formatarNumeroExcelBR(custoTotal)),
        escaparCelulaCSV(formatarNumeroExcelBR(obterTaxaVenda(v))),
        escaparCelulaCSV(formatarNumeroExcelBR(obterFreteVenda(v))),
        escaparCelulaCSV(formatarNumeroExcelBR(lucro)),
        escaparCelulaCSV(v.abaixo_preco_minimo ? "Sim" : "Não"),
        escaparCelulaCSV(v.observacao || "")
      ].join(";"));
    });
    linhas.push("");

    // BLOCO 3: ENTRADAS / POSIÇÃO DE ESTOQUE POR PRODUTO
    linhas.push([
      escaparCelulaCSV("3. ENTRADAS E POSIÇÃO ATUAL DO ESTOQUE (PRODUTOS CADASTRADOS)")
    ].join(";"));
    linhas.push([
      escaparCelulaCSV("Produto"),
      escaparCelulaCSV("Categoria / Subcategoria"),
      escaparCelulaCSV("Status"),
      escaparCelulaCSV("Quantidade em Estoque"),
      escaparCelulaCSV("Preço de Custo Unitário (R$)"),
      escaparCelulaCSV("Total Investido em Estoque (R$)"),
      escaparCelulaCSV("Preço Mínimo Negociação (R$)"),
      escaparCelulaCSV("Preço de Venda (R$)"),
      escaparCelulaCSV("Lucro Unitário Estimado (R$)"),
      escaparCelulaCSV("Preço Médio Mercado (R$)"),
      escaparCelulaCSV("Data da Pesquisa")
    ].join(";"));

    estado.produtos.forEach((p) => {
      const qtd = Math.max(0, Number(p.estoque) || 0);
      const custo = Number(p.preco_custo) || 0;
      const venda = Number(p.preco_venda) || 0;
      const min = Number(p.preco_minimo_negociacao) || 0;
      const medio = p.preco_medio_mercado !== null && p.preco_medio_mercado !== undefined
        ? formatarNumeroExcelBR(p.preco_medio_mercado)
        : "";

      linhas.push([
        escaparCelulaCSV(p.nome),
        escaparCelulaCSV(obterNomeCategoria(p.categoria_id, p.subcategoria)),
        escaparCelulaCSV(p.ativo ? "Ativo" : "Inativo"),
        escaparCelulaCSV(qtd),
        escaparCelulaCSV(formatarNumeroExcelBR(custo)),
        escaparCelulaCSV(formatarNumeroExcelBR(qtd * custo)),
        escaparCelulaCSV(formatarNumeroExcelBR(min)),
        escaparCelulaCSV(formatarNumeroExcelBR(venda)),
        escaparCelulaCSV(formatarNumeroExcelBR(venda - custo)),
        escaparCelulaCSV(medio),
        escaparCelulaCSV(p.data_pesquisa ? String(p.data_pesquisa).split("T")[0] : "")
      ].join(";"));
    });
    linhas.push("");

    // BLOCO 4: CLIENTES CADASTRADOS
    linhas.push([
      escaparCelulaCSV("4. CLIENTES CADASTRADOS NA LOJA")
    ].join(";"));
    linhas.push([
      escaparCelulaCSV("Nome Completo"),
      escaparCelulaCSV("WhatsApp"),
      escaparCelulaCSV("E-mail"),
      escaparCelulaCSV("Data de Nascimento"),
      escaparCelulaCSV("Bairro"),
      escaparCelulaCSV("Cidade / Estado"),
      escaparCelulaCSV("País"),
      escaparCelulaCSV("Endereço Completo de Entrega"),
      escaparCelulaCSV("Data de Cadastro")
    ].join(";"));

    (estado.clientes || []).forEach((c) => {
      linhas.push([
        escaparCelulaCSV(c.nome),
        escaparCelulaCSV(c.whatsapp),
        escaparCelulaCSV(c.email),
        escaparCelulaCSV(c.data_nascimento ? formatarDataBR(c.data_nascimento) : ""),
        escaparCelulaCSV(c.bairro || ""),
        escaparCelulaCSV([c.cidade || "Salvador", c.estado || "BA"].filter(Boolean).join(" - ")),
        escaparCelulaCSV(c.pais || "Brasil"),
        escaparCelulaCSV(c.endereco),
        escaparCelulaCSV(formatarDataHoraBR(c.criado_em))
      ].join(";"));
    });

    const nomeArquivo = `relatorio-pg-precos-justos-${chaveMes}.csv`;
    baixarArquivoCSV(nomeArquivo, linhas);
    mostrarToast("Planilha gerada com sucesso! Abra o arquivo no Excel.");
  }

  // ==========================================================================
  // 9C. MODAL DE CLIENTES CADASTRADOS
  // ==========================================================================

  function renderizarListaClientesAdmin() {
    const container = document.getElementById("listaClientesAdmin");
    const elContagem = document.getElementById("contagemClientesAdmin");
    if (!container) return;

    const lista = estado.clientes || [];
    if (elContagem) {
      elContagem.textContent = `${lista.length} ${
        lista.length === 1 ? "cliente cadastrado" : "clientes cadastrados"
      }`;
    }

    container.textContent = "";

    if (lista.length === 0) {
      const vazio = document.createElement("div");
      vazio.className = "estado-lista";
      vazio.textContent = "Nenhum cliente cadastrado ainda.";
      container.appendChild(vazio);
      return;
    }

    lista.forEach((cli) => {
      const card = document.createElement("div");
      card.className = "carrinho-item";
      card.style.alignItems = "flex-start";

      const info = document.createElement("div");
      info.style.flex = "1";

      const nome = document.createElement("div");
      nome.style.fontWeight = "600";
      nome.style.fontSize = "0.95rem";
      nome.textContent = cli.nome || "Cliente";

      const linhaContato = document.createElement("div");
      linhaContato.style.fontSize = "0.82rem";
      linhaContato.style.color = "#57534e";
      linhaContato.style.marginTop = "2px";
      linhaContato.textContent = `📱 ${cli.whatsapp || "Sem WhatsApp"} • ✉️ ${cli.email || ""}`;

      const linhaEnd = document.createElement("div");
      linhaEnd.style.fontSize = "0.83rem";
      linhaEnd.style.color = "#1c1917";
      linhaEnd.style.marginTop = "4px";
      linhaEnd.textContent = `📍 Endereço: ${cli.endereco || "Não informado"}`;

      const linhaIdade = document.createElement("div");
      linhaIdade.style.fontSize = "0.78rem";
      linhaIdade.style.marginTop = "3px";
      if (cli.data_nascimento) {
        const dNasc = parseDataLocal(cli.data_nascimento);
        let idade = null;
        if (dNasc) {
          const hj = new Date();
          idade = hj.getFullYear() - dNasc.getFullYear();
          const m = hj.getMonth() - dNasc.getMonth();
          if (m < 0 || (m === 0 && hj.getDate() < dNasc.getDate())) idade -= 1;
        }
        const maior = idade !== null && idade >= 18;
        linhaIdade.style.color = maior ? "#0f3d2e" : "#991b1b";
        linhaIdade.style.fontWeight = "600";
        linhaIdade.textContent = `🎂 Nascimento: ${formatarDataBR(cli.data_nascimento)}${
          idade !== null ? ` (${idade} anos — ${maior ? "Maior de 18 ✅" : "Menor de 18 🔞"})` : ""
        }`;
      } else {
        linhaIdade.style.color = "#78716c";
        linhaIdade.textContent = "🎂 Data de nascimento: não informada";
      }

      info.appendChild(nome);
      info.appendChild(linhaContato);
      info.appendChild(linhaEnd);
      info.appendChild(linhaIdade);

      card.appendChild(info);

      if (cli.whatsapp) {
        const numLimpo = String(cli.whatsapp).replace(/\D/g, "");
        if (numLimpo.length >= 8) {
          const linkWa = document.createElement("a");
          linkWa.className = "btn-secundario-admin";
          linkWa.style.minHeight = "34px";
          linkWa.style.padding = "0 10px";
          linkWa.style.fontSize = "0.78rem";
          linkWa.href = `https://wa.me/${numLimpo.startsWith("55") ? numLimpo : "55" + numLimpo}`;
          linkWa.target = "_blank";
          linkWa.rel = "noopener noreferrer";
          linkWa.textContent = "📲 WhatsApp";
          card.appendChild(linkWa);
        }
      }

      container.appendChild(card);
    });
  }

  function abrirModalClientesAdmin() {
    const modal = document.getElementById("modalClientesAdmin");
    renderizarListaClientesAdmin();
    if (modal) {
      modal.classList.add("aberto");
      modal.setAttribute("aria-hidden", "false");
    }
  }

  function fecharModalClientesAdmin() {
    const modal = document.getElementById("modalClientesAdmin");
    if (modal) {
      modal.classList.remove("aberto");
      modal.setAttribute("aria-hidden", "true");
    }
  }

  function exportarClientesExcel() {
    const linhas = [
      [
        escaparCelulaCSV("Nome Completo"),
        escaparCelulaCSV("WhatsApp"),
        escaparCelulaCSV("E-mail"),
        escaparCelulaCSV("Data de Nascimento"),
        escaparCelulaCSV("Bairro"),
        escaparCelulaCSV("Cidade / Estado"),
        escaparCelulaCSV("País"),
        escaparCelulaCSV("Endereço Completo de Entrega"),
        escaparCelulaCSV("Data de Cadastro")
      ].join(";")
    ];

    (estado.clientes || []).forEach((c) => {
      linhas.push(
        [
          escaparCelulaCSV(c.nome),
          escaparCelulaCSV(c.whatsapp),
          escaparCelulaCSV(c.email),
          escaparCelulaCSV(c.data_nascimento ? formatarDataBR(c.data_nascimento) : ""),
          escaparCelulaCSV(c.bairro || ""),
          escaparCelulaCSV([c.cidade || "Salvador", c.estado || "BA"].filter(Boolean).join(" - ")),
          escaparCelulaCSV(c.pais || "Brasil"),
          escaparCelulaCSV(c.endereco),
          escaparCelulaCSV(formatarDataHoraBR(c.criado_em))
        ].join(";")
      );
    });

    baixarArquivoCSV("clientes-pg-precos-justos.csv", linhas);
    mostrarToast("Lista de clientes exportada para o Excel!");
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
    document
      .getElementById("btnImportarLinkProduto")
      ?.addEventListener("click", importarDadosPorLinkProduto);
    document
      .getElementById("btnAdicionarFotoUrl")
      ?.addEventListener("click", adicionarFotoUrlNoModal);

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

    // Atualiza sugestões de subcategoria quando trocar a categoria no modal do produto
    document
      .getElementById("prodCategoria")
      ?.addEventListener("change", (e) => atualizarSugestoesSubcategoria(e.target.value));

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
    document
      .getElementById("btnRestaurarCategoriasPadrao")
      ?.addEventListener("click", aplicarCategoriasOrganizadasPadrao);

    // Modal de Áreas de Entrega
    document
      .getElementById("btnGerenciarEntregas")
      ?.addEventListener("click", abrirModalEntregas);
    document
      .getElementById("btnFecharModalEntregas")
      ?.addEventListener("click", fecharModalEntregas);
    document
      .getElementById("formNovaAreaEntrega")
      ?.addEventListener("submit", adicionarAreaEntregaSubmit);

    // Modal de Relatório Mensal e Excel
    document
      .getElementById("btnAbrirRelatorioExcel")
      ?.addEventListener("click", abrirModalRelatorioMensal);
    document
      .getElementById("btnFecharModalRelatorio")
      ?.addEventListener("click", fecharModalRelatorioMensal);
    document
      .getElementById("selectMesRelatorio")
      ?.addEventListener("change", (e) => {
        estado.mesRelatorioSelecionado = e.target.value;
        atualizarPainelRelatorioMensal();
      });
    document
      .getElementById("btnExportarExcelCompleto")
      ?.addEventListener("click", exportarPlanilhaExcelCompleta);

    // Modal de Clientes Cadastrados
    document
      .getElementById("btnAbrirClientesAdmin")
      ?.addEventListener("click", abrirModalClientesAdmin);
    document
      .getElementById("btnFecharModalClientesAdmin")
      ?.addEventListener("click", fecharModalClientesAdmin);
    document
      .getElementById("btnExportarClientesExcel")
      ?.addEventListener("click", exportarClientesExcel);
  }

  // Botão "olhinho" para mostrar/ocultar a senha em todos os campos de senha
  const SVG_OLHO =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  const SVG_OLHO_FECHADO =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  function criarIconeSvg(svgTexto) {
    return new DOMParser().parseFromString(svgTexto, "image/svg+xml").documentElement;
  }

  function ativarBotoesMostrarSenha() {
    document.querySelectorAll('input[type="password"]').forEach((input) => {
      if (input.dataset.olhoSenha) return;
      input.dataset.olhoSenha = "1";

      const envoltorio = document.createElement("div");
      envoltorio.className = "senha-envoltorio";
      input.parentNode.insertBefore(envoltorio, input);
      envoltorio.appendChild(input);

      const botao = document.createElement("button");
      botao.type = "button";
      botao.className = "btn-mostrar-senha";
      botao.setAttribute("aria-label", "Mostrar senha");
      botao.title = "Mostrar senha";
      botao.appendChild(criarIconeSvg(SVG_OLHO));
      botao.addEventListener("click", () => {
        const mostrar = input.type === "password";
        input.type = mostrar ? "text" : "password";
        const rotulo = mostrar ? "Ocultar senha" : "Mostrar senha";
        botao.setAttribute("aria-label", rotulo);
        botao.title = rotulo;
        botao.replaceChildren(criarIconeSvg(mostrar ? SVG_OLHO_FECHADO : SVG_OLHO));
        input.focus();
      });
      envoltorio.appendChild(botao);
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    ativarBotoesMostrarSenha();
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

