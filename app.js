/**
 * ============================================================================
 * LÓGICA DA VITRINE PÚBLICA - P&G PREÇOS JUSTOS
 * ============================================================================
 * Recursos incluídos:
 * - Leitura segura apenas da view 'produtos_publicos' e 'categorias'
 * - Cálculo automático da regra de Preço Médio de Mercado e validade de 60 dias
 * - Controle de estoque ("Esgotado" = 0, "Últimas unidades" < 3)
 * - Busca por nome e filtro por categoria
 * - Carrinho simples salvo no navegador + envio formatado para o WhatsApp
 * - Proteção contra XSS (uso de textContent e criação segura de nós DOM)
 */

(function () {
  "use strict";

  const CFG = window.LOJA_CONFIG || {};
  const CHAVE_STORAGE_CARRINHO = "pg_precos_justos_carrinho_v1";
  const CHAVE_STORAGE_CLIENTE = "pg_precos_justos_cliente_logado_v1";
  const CHAVE_STORAGE_CONTAS_LOCAIS = "pg_precos_justos_contas_clientes_v1";
  let supabaseInstancia = null;

  // Mapa padrão de subcategorias organizadas (Cômodos, Masculino/Feminino, etc.)
  const SUBCATEGORIAS_PADRAO_POR_SLUG = {
    "casa-e-comodos": ["Cozinha", "Sala", "Quarto", "Banheiro", "Lavanderia e Limpeza", "Jardim e Varanda"],
    "casa-e-cozinha": ["Cozinha", "Sala", "Quarto", "Banheiro", "Lavanderia e Limpeza", "Jardim e Varanda"],
    "cuidados-pessoais": ["Feminino", "Masculino", "Unissex", "Infantil", "Perfumaria", "Cabelo e Barba"],
    "moda-e-acessorios": ["Feminino", "Masculino", "Unissex", "Infantil", "Relógios e Óculos", "Bolsas e Carteiras"],
    "eletronicos-e-tecnologia": ["Áudio e Fones", "Celular e Carregadores", "Informática", "Smartwatch", "Caixas de Som"],
    "eletronicos-e-acessorios": ["Áudio e Fones", "Celular e Carregadores", "Informática", "Smartwatch", "Caixas de Som"],
    "ferramentas-e-utilidades": ["Ferramentas Manuais", "Elétrica e Iluminação", "Automotivo", "Organização"],
    "utilidades-e-ferramentas": ["Ferramentas Manuais", "Elétrica e Iluminação", "Automotivo", "Organização"],
    "infantil-e-brinquedos": ["Meninos", "Meninas", "Bebês", "Jogos e Educativos"],
    "kits-e-promocoes": ["Kits Presente Masculino", "Kits Presente Feminino", "Kits para Casa", "Queima de Estoque"],
    "ofertas-da-semana": ["Casa e Cômodos", "Masculino", "Feminino", "Eletrônicos"]
  };

  // Estado da aplicação na memória
  const estado = {
    categorias: [],
    produtos: [],
    categoriaSelecionada: "todas",
    subcategoriaSelecionada: "todas",
    termoBusca: "",
    carrinho: carregarCarrinhoSalvo(),
    clienteLogado: carregarClienteSalvo(),
    acaoPendenteCompra: null,
    modoDemo: false
  };

  // ==========================================================================
  // 1. UTILITÁRIOS DE FORMATAÇÃO E REGRAS DE NEGÓCIO (EXPORTADOS PARA TESTES)
  // ==========================================================================

  /**
   * Formata número para moeda brasileira (ex.: R$ 49,90)
   */
  function formatarMoeda(valor) {
    const num = Number(valor) || 0;
    return num.toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL"
    });
  }

  /**
   * Limpa apenas dígitos de um telefone de WhatsApp
   */
  function limparNumeroWhatsapp(numero) {
    return String(numero || "5571999915480").replace(/\D/g, "");
  }

  /**
   * Converte string YYYY-MM-DD em data local (sem desvio de fuso horário)
   */
  function parseDataLocal(dataIso) {
    if (!dataIso || typeof dataIso !== "string") return null;
    const partes = dataIso.split("T")[0].split("-");
    if (partes.length !== 3) return null;
    const ano = parseInt(partes[0], 10);
    const mes = parseInt(partes[1], 10) - 1;
    const dia = parseInt(partes[2], 10);
    const data = new Date(ano, mes, dia, 12, 0, 0);
    return isNaN(data.getTime()) ? null : data;
  }

  /**
   * Formata data YYYY-MM-DD para DD/MM
   */
  function formatarDiaMes(dataIso) {
    const d = parseDataLocal(dataIso);
    if (!d) return "";
    const dia = String(d.getDate()).padStart(2, "0");
    const mes = String(d.getMonth() + 1).padStart(2, "0");
    return `${dia}/${mes}`;
  }

  /**
   * Calcula quantos dias se passaram desde a data da pesquisa até hoje
   */
  function calcularDiasDesdePesquisa(dataIso, dataReferencia) {
    const dataPesquisa = parseDataLocal(dataIso);
    if (!dataPesquisa) return Infinity;

    const hoje = dataReferencia ? new Date(dataReferencia) : new Date();
    const hojeMeioDia = new Date(
      hoje.getFullYear(),
      hoje.getMonth(),
      hoje.getDate(),
      12,
      0,
      0
    );

    const diffMs = hojeMeioDia.getTime() - dataPesquisa.getTime();
    return Math.floor(diffMs / (1000 * 60 * 60 * 24));
  }

  /**
   * REGRA DE PREÇO MÉDIO NO MERCADO:
   * - Nunca usa "preço original" nem "de/por".
   * - Se data_pesquisa tiver mais de 60 dias: não exibe preço médio.
   * - Se preco_venda > preco_medio_mercado: não exibe comparação.
   * - Se diferença < 5%: mostra apenas preço de venda e "Preço médio no mercado: R$ X (pesquisado em DD/MM)".
   * - Se diferença >= 5%: mostra também "Economize R$ X".
   */
  function avaliarComparacaoPreco(produto, dataReferencia) {
    const precoVenda = Number(produto.preco_venda);
    const precoMedio =
      produto.preco_medio_mercado !== null &&
      produto.preco_medio_mercado !== undefined &&
      produto.preco_medio_mercado !== ""
        ? Number(produto.preco_medio_mercado)
        : null;

    const limiteDias = Number(CFG.DIAS_VALIDADE_PESQUISA) || 60;
    const limitePctEconomia = Number(CFG.DESCONTO_MINIMO_ECONOMIA_PCT) || 5;

    if (!precoMedio || precoMedio <= 0 || !produto.data_pesquisa) {
      return { exibirPrecoMedio: false, exibirEconomia: false };
    }

    // 1. Verifica validade de 60 dias da pesquisa
    const dias = calcularDiasDesdePesquisa(produto.data_pesquisa, dataReferencia);
    if (dias > limiteDias || dias < 0) {
      return { exibirPrecoMedio: false, exibirEconomia: false, motivoOculto: "pesquisa_antiga" };
    }

    // 2. Se o preço de venda for MAIOR que a média, não mostra comparação
    if (precoVenda > precoMedio) {
      return { exibirPrecoMedio: false, exibirEconomia: false, motivoOculto: "acima_da_media" };
    }

    const diferencaReais = Number((precoMedio - precoVenda).toFixed(2));
    const percentualDiferenca = (diferencaReais / precoMedio) * 100;
    const dataFormatada = formatarDiaMes(produto.data_pesquisa);

    const textoPrecoMedio = `Preço médio no mercado: ${formatarMoeda(precoMedio)} (pesquisado em ${dataFormatada})`;

    // 3. Se a diferença for de 5% ou mais, mostra também "Economize R$ X"
    if (percentualDiferenca >= limitePctEconomia && diferencaReais > 0) {
      return {
        exibirPrecoMedio: true,
        exibirEconomia: true,
        textoPrecoMedio,
        textoEconomia: `Economize ${formatarMoeda(diferencaReais)}`,
        diferencaReais,
        percentualDiferenca
      };
    }

    // 4. Diferença menor que 5%: mostra apenas as duas informações, sem selo de economia
    return {
      exibirPrecoMedio: true,
      exibirEconomia: false,
      textoPrecoMedio,
      textoEconomia: "",
      diferencaReais,
      percentualDiferenca
    };
  }

  /**
   * Avalia o status de estoque do produto:
   * - estoque <= 0 -> Esgotado e botão desativado
   * - estoque < 3 (1 ou 2) -> "Últimas unidades"
   */
  function avaliarStatusEstoque(estoque) {
    const qtd = Math.max(0, parseInt(estoque, 10) || 0);
    const limiteBaixo = Number(CFG.LIMITE_ESTOQUE_BAIXO) || 3;

    if (qtd === 0) {
      return { esgotado: true, ultimasUnidades: false, label: "Esgotado", quantidade: 0 };
    }
    if (qtd < limiteBaixo) {
      return {
        esgotado: false,
        ultimasUnidades: true,
        label: "Últimas unidades",
        quantidade: qtd
      };
    }
    return { esgotado: false, ultimasUnidades: false, label: "", quantidade: qtd };
  }

  // Expõe funções puras para a suíte de testes da Fase 4
  window.PGVitrineUtils = {
    formatarMoeda,
    formatarDiaMes,
    calcularDiasDesdePesquisa,
    avaliarComparacaoPreco,
    avaliarStatusEstoque
  };

  // ==========================================================================
  // 2. CONEXÃO COM SUPABASE E DADOS DE DEMONSTRAÇÃO
  // ==========================================================================

  function supabaseEstaConfigurado() {
    return (
      CFG.SUPABASE_URL &&
      CFG.SUPABASE_ANON_KEY &&
      !CFG.SUPABASE_URL.includes("SEU-PROJETO") &&
      !CFG.SUPABASE_ANON_KEY.includes("COLE_AQUI")
    );
  }

  function gerarDataRecenteISO(diasAtras) {
    const d = new Date();
    d.setDate(d.getDate() - diasAtras);
    const ano = d.getFullYear();
    const mes = String(d.getMonth() + 1).padStart(2, "0");
    const dia = String(d.getDate()).padStart(2, "0");
    return `${ano}-${mes}-${dia}`;
  }

  function obterDadosDemonstracao() {
    const categorias = [
      { id: "cat-casa", nome: "Casa e Cozinha", slug: "casa-e-cozinha", ordem: 1 },
      { id: "cat-eletro", nome: "Eletrônicos e Acessórios", slug: "eletronicos-e-acessorios", ordem: 2 },
      { id: "cat-cuidados", nome: "Cuidados Pessoais", slug: "cuidados-pessoais", ordem: 3 },
      { id: "cat-utilidades", nome: "Utilidades e Ferramentas", slug: "utilidades-e-ferramentas", ordem: 4 }
    ];

    const produtos = [
      {
        id: "demo-1",
        nome: "Garrafa Térmica Inox 1 Litro com Visor LED",
        descricao: "Conserva líquidos quentes ou gelados por até 12 horas. Ideal para café, chá e água no dia a dia.",
        categoria_id: "cat-casa",
        categoria_nome: "Casa e Cozinha",
        foto_url: "https://images.unsplash.com/photo-1602143407151-7111542de6e8?auto=format&fit=crop&w=700&q=80",
        preco_venda: 59.9,
        preco_medio_mercado: 79.9, // > 5% de economia -> mostra "Economize R$ 20,00"
        data_pesquisa: gerarDataRecenteISO(8),
        estoque: 6,
        destaque: true
      },
      {
        id: "demo-2",
        nome: "Fone de Ouvido Bluetooth 5.3 TWS com Case",
        descricao: "Som nítido, microfone embutido para chamadas e bateria de longa duração no estojo carregador.",
        categoria_id: "cat-eletro",
        categoria_nome: "Eletrônicos e Acessórios",
        foto_url: "https://images.unsplash.com/photo-1590658268037-6bf12165a8df?auto=format&fit=crop&w=700&q=80",
        preco_venda: 69.9,
        preco_medio_mercado: 89.9, // > 5% de economia -> mostra "Economize R$ 20,00"
        data_pesquisa: gerarDataRecenteISO(5),
        estoque: 2, // < 3 -> mostra "Últimas unidades"
        destaque: true
      },
      {
        id: "demo-3",
        nome: "Kit 4 Potes Herméticos Empilháveis 1,2L",
        descricao: "Vedação com anel de silicone que mantém alimentos secos e crocantes por muito mais tempo.",
        categoria_id: "cat-casa",
        categoria_nome: "Casa e Cozinha",
        foto_url: "https://images.unsplash.com/photo-1584346133934-a3afd2a33c4c?auto=format&fit=crop&w=700&q=80",
        preco_venda: 82.0,
        preco_medio_mercado: 85.0, // ~3.5% (< 5%) -> mostra preço médio SEM "Economize R$ X"
        data_pesquisa: gerarDataRecenteISO(12),
        estoque: 5,
        destaque: false
      },
      {
        id: "demo-4",
        nome: "Mini Processador e Triturador Elétrico USB 250ml",
        descricao: "Prático para triturar alho, cebola, temperos e castanhas em segundos com apenas um toque.",
        categoria_id: "cat-casa",
        categoria_nome: "Casa e Cozinha",
        foto_url: "https://images.unsplash.com/photo-1556911220-bff31c812dba?auto=format&fit=crop&w=700&q=80",
        preco_venda: 38.9,
        preco_medio_mercado: 54.9,
        data_pesquisa: gerarDataRecenteISO(15),
        estoque: 0, // Estoque 0 -> Mostra "Esgotado" e desativa botões
        destaque: false
      },
      {
        id: "demo-5",
        nome: "Aparador de Pelos Recarregável Bivolt",
        descricao: "Pentes de altura ajustáveis, lâmina precisa e bateria recarregável via cabo USB.",
        categoria_id: "cat-cuidados",
        categoria_nome: "Cuidados Pessoais",
        foto_url: "https://images.unsplash.com/photo-1621607512214-68297480165e?auto=format&fit=crop&w=700&q=80",
        preco_venda: 54.9,
        preco_medio_mercado: 69.9,
        data_pesquisa: gerarDataRecenteISO(3),
        estoque: 1, // < 3 -> "Últimas unidades"
        destaque: true
      },
      {
        id: "demo-6",
        nome: "Jogo de Chaves de Precisão 31 Peças com Estojo",
        descricao: "Pontas imantadas em aço resistente para manutenção de pequenos aparelhos, óculos e utilidades.",
        categoria_id: "cat-utilidades",
        categoria_nome: "Utilidades e Ferramentas",
        foto_url: "https://images.unsplash.com/photo-1581147036324-c1c9bf853b64?auto=format&fit=crop&w=700&q=80",
        preco_venda: 34.9,
        preco_medio_mercado: 44.9,
        data_pesquisa: gerarDataRecenteISO(75), // > 60 dias -> NÃO exibe preço médio
        estoque: 8,
        destaque: false
      }
    ];

    return { categorias, produtos };
  }

  async function carregarDadosVitrine() {
    if (!supabaseEstaConfigurado() || !window.supabase) {
      estado.modoDemo = true;
      const demo = obterDadosDemonstracao();
      estado.categorias = demo.categorias;
      estado.produtos = demo.produtos;
      const aviso = document.getElementById("avisoDemo");
      if (aviso) aviso.style.display = "block";
      renderizarCategorias();
      renderizarVitrine();
      return;
    }

    try {
      const cliente = window.supabase.createClient(
        CFG.SUPABASE_URL,
        CFG.SUPABASE_ANON_KEY
      );
      supabaseInstancia = cliente;

      // Visitantes consultam APENAS 'categorias' e a view pública 'produtos_publicos'
      const [resCategorias, resProdutos] = await Promise.all([
        cliente
          .from("categorias")
          .select("*")
          .order("ordem", { ascending: true })
          .order("nome", { ascending: true }),
        cliente
          .from("produtos_publicos")
          .select("*")
          .order("destaque", { ascending: false })
          .order("criado_em", { ascending: false })
      ]);

      if (resCategorias.error) throw resCategorias.error;
      if (resProdutos.error) throw resProdutos.error;

      estado.categorias = resCategorias.data || [];
      estado.produtos = resProdutos.data || [];
    } catch (erro) {
      console.error("Erro ao carregar dados do Supabase:", erro);
      mostrarToast("Não foi possível carregar os produtos no momento.");
    }

    // Categorias arquivadas no admin (e os produtos delas) não aparecem na vitrine
    const idsArquivadas = new Set(
      estado.categorias.filter((c) => c.arquivada).map((c) => String(c.id))
    );
    if (idsArquivadas.size > 0) {
      estado.categorias = estado.categorias.filter((c) => !c.arquivada);
      estado.produtos = estado.produtos.filter(
        (p) => !idsArquivadas.has(String(p.categoria_id))
      );
    }

    renderizarCategorias();
    renderizarVitrine();
  }

  // ==========================================================================
  // 3. RENDERIZAÇÃO SEGURA (ANTI-XSS) DOS CARDS E FILTROS
  // ==========================================================================

  function aplicarDadosConfigNaPagina() {
    const nomeLoja = CFG.NOME_LOJA || "P&G Preços Justos";
    const numeroLimpo = limparNumeroWhatsapp(CFG.WHATSAPP_NUMERO);
    const whatsappExibicao = CFG.WHATSAPP_EXIBICAO || "(71) 99991-5480";
    const instagramUsuario = (CFG.INSTAGRAM_USUARIO || "precosjustos.pg").replace(/^@/, "");
    const instagramUrl = CFG.INSTAGRAM_URL || `https://instagram.com/${instagramUsuario}`;

    document.title = `${nomeLoja} | Catálogo de Ofertas`;

    const elNomeTopo = document.getElementById("nomeLojaTopo");
    const elNomeRodape = document.getElementById("nomeLojaRodape");
    const elNomeCopy = document.getElementById("nomeLojaCopy");
    const elSloganRodape = document.getElementById("sloganRodape");
    const elBannerTag = document.getElementById("bannerTag");
    const elBannerTitulo = document.getElementById("bannerTitulo");
    const elBannerSub = document.getElementById("bannerSubtitulo");
    const elAno = document.getElementById("anoAtual");

    if (elNomeTopo) elNomeTopo.textContent = nomeLoja;
    if (elNomeRodape) elNomeRodape.textContent = nomeLoja;
    if (elNomeCopy) elNomeCopy.textContent = nomeLoja;
    if (elSloganRodape && CFG.SLOGAN) elSloganRodape.textContent = CFG.SLOGAN;
    if (elBannerTag && CFG.BANNER_TAG) elBannerTag.textContent = CFG.BANNER_TAG;
    if (elBannerTitulo && CFG.BANNER_TITULO) elBannerTitulo.textContent = CFG.BANNER_TITULO;
    if (elBannerSub && CFG.BANNER_SUBTITULO) elBannerSub.textContent = CFG.BANNER_SUBTITULO;
    if (elAno) elAno.textContent = String(new Date().getFullYear());

    const msgGeral = encodeURIComponent(
      `Olá! Vim pelo catálogo da *${nomeLoja}* e gostaria de realizar uma compra.`
    );
    const urlWaGeral = `https://wa.me/${numeroLimpo}?text=${msgGeral}`;

    const btnFlutuante = document.getElementById("btnWhatsappFlutuante");
    const linkWaRodape = document.getElementById("linkWhatsappRodape");
    const linkInstaRodape = document.getElementById("linkInstagramRodape");

    if (btnFlutuante) btnFlutuante.href = urlWaGeral;
    if (linkWaRodape) {
      linkWaRodape.href = urlWaGeral;
      linkWaRodape.textContent = `WhatsApp: ${whatsappExibicao}`;
    }
    if (linkInstaRodape) {
      linkInstaRodape.href = instagramUrl;
      linkInstaRodape.textContent = `Instagram: @${instagramUsuario}`;
    }
  }

  function obterSubcategoriasDaCategoria(cat) {
    if (!cat) return [];
    if (Array.isArray(cat.subcategorias) && cat.subcategorias.length > 0) {
      return cat.subcategorias;
    }
    const padrao = SUBCATEGORIAS_PADRAO_POR_SLUG[cat.slug] || [];
    // Adiciona eventuais subcategorias cadastradas nos produtos dessa categoria
    const extrasProdutos = estado.produtos
      .filter((p) => String(p.categoria_id) === String(cat.id) && p.subcategoria)
      .map((p) => String(p.subcategoria).trim());
    return Array.from(new Set([...padrao, ...extrasProdutos])).filter(Boolean);
  }

  function renderizarCategorias() {
    const container = document.getElementById("listaCategorias");
    if (!container) return;

    container.textContent = "";

    const btnTodas = document.createElement("button");
    btnTodas.type = "button";
    btnTodas.className =
      "btn-categoria" + (estado.categoriaSelecionada === "todas" ? " ativa" : "");
    btnTodas.dataset.categoria = "todas";
    btnTodas.textContent = "Todas as Categorias";
    btnTodas.addEventListener("click", () => selecionarCategoria("todas"));
    container.appendChild(btnTodas);

    estado.categorias.forEach((cat) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "btn-categoria" + (estado.categoriaSelecionada === String(cat.id) ? " ativa" : "");
      btn.dataset.categoria = String(cat.id);
      btn.textContent = cat.nome;
      btn.addEventListener("click", () => selecionarCategoria(String(cat.id)));
      container.appendChild(btn);
    });

    renderizarSubcategorias();
  }

  function renderizarSubcategorias() {
    const containerSub = document.getElementById("listaSubcategorias");
    if (!containerSub) return;

    containerSub.textContent = "";

    if (estado.categoriaSelecionada === "todas") {
      containerSub.style.display = "none";
      return;
    }

    const catAtiva = estado.categorias.find(
      (c) => String(c.id) === String(estado.categoriaSelecionada)
    );
    const subcategorias = obterSubcategoriasDaCategoria(catAtiva);

    if (subcategorias.length === 0) {
      containerSub.style.display = "none";
      return;
    }

    containerSub.style.display = "flex";

    const btnTodasSub = document.createElement("button");
    btnTodasSub.type = "button";
    btnTodasSub.className =
      "btn-subcategoria" + (estado.subcategoriaSelecionada === "todas" ? " ativa" : "");
    btnTodasSub.textContent = `Tudo em ${catAtiva.nome}`;
    btnTodasSub.addEventListener("click", () => selecionarSubcategoria("todas"));
    containerSub.appendChild(btnTodasSub);

    subcategorias.forEach((sub) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "btn-subcategoria" + (estado.subcategoriaSelecionada === sub ? " ativa" : "");
      btn.textContent = sub;
      btn.addEventListener("click", () => selecionarSubcategoria(sub));
      containerSub.appendChild(btn);
    });
  }

  function selecionarCategoria(idCategoria) {
    estado.categoriaSelecionada = idCategoria;
    estado.subcategoriaSelecionada = "todas";
    renderizarCategorias();
    renderizarVitrine();
  }

  function selecionarSubcategoria(nomeSubcategoria) {
    estado.subcategoriaSelecionada = nomeSubcategoria;
    renderizarSubcategorias();
    renderizarVitrine();
  }

  /**
   * Cria uma imagem placeholder SVG leve caso o produto não tenha foto cadastrada
   */
  function obterFotoSegura(fotoUrl) {
    if (fotoUrl && /^https?:\/\//i.test(String(fotoUrl).trim())) {
      return String(fotoUrl).trim();
    }
    return (
      "data:image/svg+xml;charset=UTF-8," +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="450" viewBox="0 0 600 450">
          <rect width="600" height="450" fill="#e6f4ee"/>
          <text x="50%" y="48%" dominant-baseline="middle" text-anchor="middle" fill="#0f3d2e" font-family="sans-serif" font-size="24" font-weight="bold">P&amp;G Preços Justos</text>
          <text x="50%" y="56%" dominant-baseline="middle" text-anchor="middle" fill="#57534e" font-family="sans-serif" font-size="16">Foto em breve</text>
        </svg>`
      )
    );
  }

  /**
   * Constrói o card de um produto de forma 100% segura contra XSS (usando createElement e textContent)
   */
  function criarCardProduto(produto) {
    const statusEstoque = avaliarStatusEstoque(produto.estoque);
    const comparacao = avaliarComparacaoPreco(produto);

    const artigo = document.createElement("article");
    artigo.className = "produto-card" + (statusEstoque.esgotado ? " esgotado" : "");

    // 1. Mídia (Imagem com lazy loading + selos de topo)
    const divMidia = document.createElement("div");
    divMidia.className = "produto-midia";

    const img = document.createElement("img");
    img.src = obterFotoSegura(produto.foto_url);
    img.alt = produto.nome || "Produto";
    img.loading = "lazy";
    img.decoding = "async";
    img.addEventListener("error", () => {
      img.src = obterFotoSegura("");
    });
    divMidia.appendChild(img);

    const divSelos = document.createElement("div");
    divSelos.className = "produto-selos-topo";

    const spanEsq = document.createElement("span");
    if (produto.destaque) {
      spanEsq.className = "selo selo-destaque";
      spanEsq.textContent = "Destaque";
    }
    divSelos.appendChild(spanEsq);

    if (statusEstoque.esgotado) {
      const seloEsgotado = document.createElement("span");
      seloEsgotado.className = "selo selo-esgotado";
      seloEsgotado.textContent = "Esgotado";
      divSelos.appendChild(seloEsgotado);
    } else if (statusEstoque.ultimasUnidades) {
      const seloUltimas = document.createElement("span");
      seloUltimas.className = "selo selo-ultimas-unidades";
      seloUltimas.textContent = "Últimas unidades";
      divSelos.appendChild(seloUltimas);
    }

    divMidia.appendChild(divSelos);
    artigo.appendChild(divMidia);

    // 2. Corpo do Card
    const divCorpo = document.createElement("div");
    divCorpo.className = "produto-corpo";

    if (produto.categoria_nome || produto.subcategoria) {
      const spanCat = document.createElement("span");
      spanCat.className = "produto-categoria-tag";
      spanCat.textContent =
        produto.categoria_nome && produto.subcategoria
          ? `${produto.categoria_nome} • ${produto.subcategoria}`
          : produto.categoria_nome || produto.subcategoria;
      divCorpo.appendChild(spanCat);
    }

    const titulo = document.createElement("h3");
    titulo.className = "produto-nome";
    titulo.textContent = produto.nome;
    divCorpo.appendChild(titulo);

    if (produto.descricao) {
      const desc = document.createElement("p");
      desc.className = "produto-descricao";
      desc.textContent = produto.descricao;
      divCorpo.appendChild(desc);
    }

    // 3. Bloco de Preço e Comparação de Mercado
    const blocoPreco = document.createElement("div");
    blocoPreco.className = "produto-bloco-preco";

    const linhaPrincipal = document.createElement("div");
    linhaPrincipal.className = "preco-linha-principal";

    const spanPrecoVenda = document.createElement("span");
    spanPrecoVenda.className = "preco-venda-valor";
    spanPrecoVenda.textContent = formatarMoeda(produto.preco_venda);
    linhaPrincipal.appendChild(spanPrecoVenda);

    // Se a diferença for >= 5%, exibe "Economize R$ X"
    if (comparacao.exibirEconomia) {
      const spanEconomia = document.createElement("span");
      spanEconomia.className = "selo-economize";
      spanEconomia.textContent = comparacao.textoEconomia;
      linhaPrincipal.appendChild(spanEconomia);
    }

    blocoPreco.appendChild(linhaPrincipal);

    // Se a pesquisa tiver <= 60 dias e o preço de venda não for maior que a média
    if (comparacao.exibirPrecoMedio) {
      const pMedio = document.createElement("p");
      pMedio.className = "preco-medio-info";
      pMedio.textContent = comparacao.textoPrecoMedio;
      blocoPreco.appendChild(pMedio);
    }

    divCorpo.appendChild(blocoPreco);

    // 4. Botões de Ação ("Pedir pelo WhatsApp" e "Adicionar ao Pedido")
    const divAcoes = document.createElement("div");
    divAcoes.className = "produto-acoes";

    const btnWhatsapp = document.createElement("button");
    btnWhatsapp.type = "button";
    btnWhatsapp.className = "btn-pedir-whatsapp";

    const btnCarrinho = document.createElement("button");
    btnCarrinho.type = "button";
    btnCarrinho.className = "btn-adicionar-carrinho";

    if (statusEstoque.esgotado) {
      btnWhatsapp.disabled = true;
      btnWhatsapp.textContent = "Produto Esgotado";
      btnCarrinho.disabled = true;
      btnCarrinho.textContent = "Indisponível no momento";
    } else {
      btnWhatsapp.textContent = "📲 Pedir pelo WhatsApp";
      btnWhatsapp.addEventListener("click", () => pedirProdutoDiretoWhatsapp(produto));

      btnCarrinho.textContent = "🛒 Adicionar ao Pedido";
      btnCarrinho.addEventListener("click", () => adicionarAoCarrinho(produto));
    }

    divAcoes.appendChild(btnWhatsapp);
    divAcoes.appendChild(btnCarrinho);
    divCorpo.appendChild(divAcoes);

    artigo.appendChild(divCorpo);
    return artigo;
  }

  function renderizarVitrine() {
    const secaoDestaques = document.getElementById("secaoDestaques");
    const gradeDestaques = document.getElementById("gradeDestaques");
    const contagemDestaques = document.getElementById("contagemDestaques");

    const gradeProdutos = document.getElementById("gradeProdutos");
    const contagemProdutos = document.getElementById("contagemProdutos");
    const tituloGrade = document.getElementById("tituloGradePrincipal");

    if (!gradeProdutos) return;

    const termo = estado.termoBusca.trim().toLowerCase();
    const filtrando =
      termo.length > 0 ||
      estado.categoriaSelecionada !== "todas" ||
      estado.subcategoriaSelecionada !== "todas";

    // Filtra os produtos pela categoria, subcategoria (cômodo/gênero) e pelo nome buscado
    const produtosFiltrados = estado.produtos.filter((p) => {
      const bateCategoria =
        estado.categoriaSelecionada === "todas" ||
        String(p.categoria_id) === estado.categoriaSelecionada;

      const bateSubcategoria =
        estado.subcategoriaSelecionada === "todas" ||
        String(p.subcategoria || "").toLowerCase() ===
          estado.subcategoriaSelecionada.toLowerCase();

      const bateBusca =
        !termo ||
        String(p.nome || "").toLowerCase().includes(termo) ||
        String(p.subcategoria || "").toLowerCase().includes(termo);

      return bateCategoria && bateSubcategoria && bateBusca;
    });

    // Seção de Destaques: exibe na tela inicial quando não há busca/filtro específico ativo
    const destaques = estado.produtos.filter((p) => p.destaque === true);
    if (!filtrando && destaques.length > 0 && secaoDestaques && gradeDestaques) {
      secaoDestaques.style.display = "block";
      gradeDestaques.textContent = "";
      if (contagemDestaques) {
        contagemDestaques.textContent = `${destaques.length} ${
          destaques.length === 1 ? "item" : "itens"
        }`;
      }
      destaques.forEach((prod) => {
        gradeDestaques.appendChild(criarCardProduto(prod));
      });
    } else if (secaoDestaques) {
      secaoDestaques.style.display = "none";
    }

    // Atualiza título da grade principal
    if (tituloGrade) {
      if (estado.categoriaSelecionada !== "todas") {
        const catObj = estado.categorias.find(
          (c) => String(c.id) === estado.categoriaSelecionada
        );
        const nomeBase = catObj ? catObj.nome : "Produtos";
        tituloGrade.textContent =
          estado.subcategoriaSelecionada !== "todas"
            ? `${nomeBase} — ${estado.subcategoriaSelecionada}`
            : nomeBase;
      } else if (termo) {
        tituloGrade.textContent = `Resultados para "${estado.termoBusca.trim()}"`;
      } else {
        tituloGrade.textContent = "Catálogo de Produtos";
      }
    }

    if (contagemProdutos) {
      contagemProdutos.textContent = `${produtosFiltrados.length} ${
        produtosFiltrados.length === 1 ? "produto" : "produtos"
      }`;
    }

    gradeProdutos.textContent = "";

    if (produtosFiltrados.length === 0) {
      const vazio = document.createElement("div");
      vazio.className = "estado-lista";
      vazio.textContent =
        estado.produtos.length === 0
          ? "Nosso catálogo está sendo atualizado com novas ofertas. Volte em instantes ou fale conosco pelo WhatsApp!"
          : "Nenhum produto encontrado para este filtro. Tente buscar por outro termo ou selecionar Todas as Categorias.";
      gradeProdutos.appendChild(vazio);
      return;
    }

    produtosFiltrados.forEach((prod) => {
      gradeProdutos.appendChild(criarCardProduto(prod));
    });
  }

  // ==========================================================================
  // 4. PEDIDO DIRETO E CARRINHO SIMPLES COM MENSAGEM ÚNICA PARA O WHATSAPP
  // ==========================================================================

  function montarBlocoIdentificacaoCliente() {
    if (!estado.clienteLogado || !estado.clienteLogado.nome) return [];
    const linhas = [
      ``,
      `*Dados do Cliente:*`,
      `• Nome: ${estado.clienteLogado.nome}`
    ];
    if (estado.clienteLogado.whatsapp) {
      linhas.push(`• WhatsApp: ${estado.clienteLogado.whatsapp}`);
    }
    if (estado.clienteLogado.endereco) {
      linhas.push(`• Endereço/Bairro: ${estado.clienteLogado.endereco}`);
    }
    return linhas;
  }

  function clienteEstaAptoParaCompra() {
    return Boolean(
      estado.clienteLogado &&
        estado.clienteLogado.nome &&
        String(estado.clienteLogado.endereco || "").trim().length >= 5
    );
  }

  function solicitarLoginOuCadastroParaCompra(acaoPendente) {
    estado.acaoPendenteCompra = acaoPendente;

    // Fecha a gaveta do carrinho caso esteja aberta
    const overlayCarrinho = document.getElementById("carrinhoOverlay");
    if (overlayCarrinho) {
      overlayCarrinho.classList.remove("aberto");
      overlayCarrinho.setAttribute("aria-hidden", "true");
    }

    const modalCliente = document.getElementById("modalContaCliente");
    if (modalCliente) {
      atualizarInterfaceContaCliente();
      alternarAbaModalCliente("cadastrar");
      exibirFeedbackCliente(
        "🔒 Para finalizar seu pedido, faça login ou cadastre-se informando seu endereço completo de entrega.",
        "erro"
      );
      modalCliente.classList.add("aberto");
      modalCliente.setAttribute("aria-hidden", "false");
    }
  }

  function executarAcaoPendentePosLogin() {
    if (!estado.acaoPendenteCompra || !clienteEstaAptoParaCompra()) return;
    const acao = estado.acaoPendenteCompra;
    estado.acaoPendenteCompra = null;

    const modalCliente = document.getElementById("modalContaCliente");
    if (modalCliente) {
      modalCliente.classList.remove("aberto");
      modalCliente.setAttribute("aria-hidden", "true");
    }

    if (acao.tipo === "produto" && acao.produto) {
      pedirProdutoDiretoWhatsapp(acao.produto);
    } else if (acao.tipo === "carrinho") {
      enviarCarrinhoWhatsapp();
    }
  }

  function pedirProdutoDiretoWhatsapp(produto) {
    if (!clienteEstaAptoParaCompra()) {
      solicitarLoginOuCadastroParaCompra({ tipo: "produto", produto });
      return;
    }

    const numero = limparNumeroWhatsapp(CFG.WHATSAPP_NUMERO);
    const nomeLoja = CFG.NOME_LOJA || "P&G Preços Justos";
    const precoFormatado = formatarMoeda(produto.preco_venda);

    const mensagem = [
      `Olá, *${nomeLoja}*!`,
      `Gostaria de pedir este produto do catálogo:`,
      ``,
      `• *${produto.nome}*`,
      `  Valor: *${precoFormatado}*`,
      ...montarBlocoIdentificacaoCliente(),
      ``,
      `Podemos confirmar a disponibilidade e o pagamento (Pix ou Cartão)?`
    ].join("\n");

    const url = `https://wa.me/${numero}?text=${encodeURIComponent(mensagem)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function carregarCarrinhoSalvo() {
    try {
      const bruto = localStorage.getItem(CHAVE_STORAGE_CARRINHO);
      if (!bruto) return [];
      const lido = JSON.parse(bruto);
      return Array.isArray(lido) ? lido : [];
    } catch (_) {
      return [];
    }
  }

  function carregarClienteSalvo() {
    try {
      const bruto = localStorage.getItem(CHAVE_STORAGE_CLIENTE);
      if (!bruto) return null;
      const lido = JSON.parse(bruto);
      return lido && lido.email ? lido : null;
    } catch (_) {
      return null;
    }
  }

  function salvarClienteLogado(cliente) {
    estado.clienteLogado = cliente;
    try {
      if (cliente) {
        localStorage.setItem(CHAVE_STORAGE_CLIENTE, JSON.stringify(cliente));
      } else {
        localStorage.removeItem(CHAVE_STORAGE_CLIENTE);
      }
    } catch (_) {
      // Ignora erro de quota
    }
    atualizarInterfaceContaCliente();
  }

  function atualizarInterfaceContaCliente() {
    const elTextoTopo = document.getElementById("textoBtnContaTopo");
    const abas = document.getElementById("abasContaCliente");
    const formLogin = document.getElementById("formLoginCliente");
    const formCadastro = document.getElementById("formCadastroCliente");
    const painelLogado = document.getElementById("painelClienteLogado");

    if (estado.clienteLogado && estado.clienteLogado.nome) {
      const primeiroNome = String(estado.clienteLogado.nome).trim().split(" ")[0];
      if (elTextoTopo) elTextoTopo.textContent = `Olá, ${primeiroNome}`;
      if (abas) abas.style.display = "none";
      if (formLogin) formLogin.style.display = "none";
      if (formCadastro) formCadastro.style.display = "none";
      if (painelLogado) {
        painelLogado.style.display = "block";
        document.getElementById("perfilClienteNome").textContent =
          estado.clienteLogado.nome || "";
        document.getElementById("perfilClienteEmail").textContent =
          estado.clienteLogado.email || "";
        document.getElementById("perfilClienteWhatsapp").textContent =
          estado.clienteLogado.whatsapp || "Não informado";
        document.getElementById("perfilClienteEndereco").textContent =
          estado.clienteLogado.endereco || "Não informado";
      }
    } else {
      if (elTextoTopo) elTextoTopo.textContent = "Entrar / Cadastrar";
      if (abas) abas.style.display = "grid";
      if (painelLogado) painelLogado.style.display = "none";
    }
  }

  function exibirFeedbackCliente(mensagem, tipo = "erro") {
    const el = document.getElementById("feedbackContaCliente");
    if (!el) return;
    if (!mensagem) {
      el.className = "msg-feedback-cliente";
      el.textContent = "";
      return;
    }
    el.className = `msg-feedback-cliente ${tipo}`;
    el.textContent = mensagem;
  }

  function alternarAbaModalCliente(aba) {
    exibirFeedbackCliente("");
    const btnEntrar = document.getElementById("abaBtnEntrar");
    const btnCadastrar = document.getElementById("abaBtnCadastrar");
    const formLogin = document.getElementById("formLoginCliente");
    const formCadastro = document.getElementById("formCadastroCliente");

    if (aba === "cadastrar") {
      btnEntrar?.classList.remove("ativa");
      btnCadastrar?.classList.add("ativa");
      if (formLogin) formLogin.style.display = "none";
      if (formCadastro) formCadastro.style.display = "block";
    } else {
      btnCadastrar?.classList.remove("ativa");
      btnEntrar?.classList.add("ativa");
      if (formCadastro) formCadastro.style.display = "none";
      if (formLogin) formLogin.style.display = "block";
    }
  }

  async function cadastrarClienteSubmit(evento) {
    evento.preventDefault();
    exibirFeedbackCliente("");

    const nome = String(document.getElementById("cadClienteNome")?.value || "").trim();
    const email = String(document.getElementById("cadClienteEmail")?.value || "")
      .trim()
      .toLowerCase();
    const whatsapp = String(document.getElementById("cadClienteWhatsapp")?.value || "").trim();
    const endereco = String(document.getElementById("cadClienteEndereco")?.value || "").trim();
    const senha = String(document.getElementById("cadClienteSenha")?.value || "");
    const btn = document.getElementById("btnSubmitCadastroCliente");

    if (nome.length < 2) {
      exibirFeedbackCliente("Por favor, informe seu nome completo.");
      return;
    }
    if (!email.includes("@")) {
      exibirFeedbackCliente("Por favor, informe um e-mail válido.");
      return;
    }
    if (whatsapp.replace(/\D/g, "").length < 8) {
      exibirFeedbackCliente("Por favor, informe seu WhatsApp com DDD.");
      return;
    }
    if (endereco.length < 5) {
      exibirFeedbackCliente(
        "O endereço de entrega é obrigatório. Informe rua, número e bairro."
      );
      return;
    }
    if (senha.length < 6) {
      exibirFeedbackCliente("A senha deve ter pelo menos 6 caracteres.");
      return;
    }

    try {
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Criando conta...";
      }

      let dadosCliente = null;

      if (supabaseInstancia) {
        const { data, error } = await supabaseInstancia.rpc("cadastrar_cliente_loja", {
          p_nome: nome,
          p_email: email,
          p_whatsapp: whatsapp,
          p_endereco: endereco,
          p_senha: senha
        });

        if (error) {
          // Se a função RPC ainda não foi rodada no SQL do Supabase, usa armazenamento local seguro
          if (
            String(error.message || "").includes("cadastrar_cliente_loja") ||
            String(error.code || "") === "PGRST202"
          ) {
            dadosCliente = cadastrarClienteLocalFallback({
              nome,
              email,
              whatsapp,
              endereco,
              senha
            });
          } else {
            throw new Error(error.message);
          }
        } else {
          dadosCliente = data;
        }
      } else {
        dadosCliente = cadastrarClienteLocalFallback({
          nome,
          email,
          whatsapp,
          endereco,
          senha
        });
      }

      salvarClienteLogado(dadosCliente);
      mostrarToast(`Bem-vindo(a), ${nome.split(" ")[0]}! Conta criada com sucesso.`);
      document.getElementById("formCadastroCliente")?.reset();
      executarAcaoPendentePosLogin();
    } catch (erro) {
      exibirFeedbackCliente(erro.message || "Não foi possível concluir o cadastro.");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Criar Minha Conta";
      }
    }
  }

  async function loginClienteSubmit(evento) {
    evento.preventDefault();
    exibirFeedbackCliente("");

    const email = String(document.getElementById("loginClienteEmail")?.value || "")
      .trim()
      .toLowerCase();
    const senha = String(document.getElementById("loginClienteSenha")?.value || "");
    const btn = document.getElementById("btnSubmitLoginCliente");

    try {
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Entrando...";
      }

      let dadosCliente = null;

      if (supabaseInstancia) {
        const { data, error } = await supabaseInstancia.rpc("entrar_cliente_loja", {
          p_email: email,
          p_senha: senha
        });

        if (error) {
          if (
            String(error.message || "").includes("entrar_cliente_loja") ||
            String(error.code || "") === "PGRST202"
          ) {
            dadosCliente = loginClienteLocalFallback(email, senha);
          } else {
            throw new Error(error.message);
          }
        } else {
          dadosCliente = data;
        }
      } else {
        dadosCliente = loginClienteLocalFallback(email, senha);
      }

      salvarClienteLogado(dadosCliente);
      mostrarToast(`Olá, ${dadosCliente.nome.split(" ")[0]}!`);
      document.getElementById("formLoginCliente")?.reset();
      executarAcaoPendentePosLogin();
    } catch (erro) {
      exibirFeedbackCliente(erro.message || "E-mail ou senha incorretos.");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Entrar na Minha Conta";
      }
    }
  }

  function cadastrarClienteLocalFallback({ nome, email, whatsapp, endereco, senha }) {
    let lista = [];
    try {
      lista = JSON.parse(localStorage.getItem(CHAVE_STORAGE_CONTAS_LOCAIS) || "[]");
    } catch (_) {
      lista = [];
    }
    if (lista.some((c) => c.email === email)) {
      throw new Error("Este e-mail já está cadastrado. Acesse a aba Entrar.");
    }
    const novo = {
      id: "cli-" + Date.now(),
      nome,
      email,
      whatsapp,
      endereco,
      senha
    };
    lista.push(novo);
    try {
      localStorage.setItem(CHAVE_STORAGE_CONTAS_LOCAIS, JSON.stringify(lista));
    } catch (_) {}
    return { id: novo.id, nome, email, whatsapp, endereco };
  }

  function loginClienteLocalFallback(email, senha) {
    let lista = [];
    try {
      lista = JSON.parse(localStorage.getItem(CHAVE_STORAGE_CONTAS_LOCAIS) || "[]");
    } catch (_) {
      lista = [];
    }
    const encontrado = lista.find((c) => c.email === email && c.senha === senha);
    if (!encontrado) {
      throw new Error("E-mail ou senha incorretos.");
    }
    return {
      id: encontrado.id,
      nome: encontrado.nome,
      email: encontrado.email,
      whatsapp: encontrado.whatsapp,
      endereco: encontrado.endereco
    };
  }

  function salvarCarrinho() {
    try {
      localStorage.setItem(CHAVE_STORAGE_CARRINHO, JSON.stringify(estado.carrinho));
    } catch (_) {
      // Ignora erro de quota
    }
  }

  function adicionarAoCarrinho(produto) {
    const estoqueMax = Math.max(0, parseInt(produto.estoque, 10) || 0);
    if (estoqueMax <= 0) {
      mostrarToast("Produto esgotado.");
      return;
    }

    const existente = estado.carrinho.find((item) => item.id === produto.id);
    if (existente) {
      if (existente.quantidade >= estoqueMax) {
        mostrarToast(
          `Limite disponível em estoque atingido (${estoqueMax} ${
            estoqueMax === 1 ? "unidade" : "unidades"
          }).`
        );
        return;
      }
      existente.quantidade += 1;
      existente.preco_venda = Number(produto.preco_venda);
      existente.estoque = estoqueMax;
    } else {
      estado.carrinho.push({
        id: produto.id,
        nome: produto.nome,
        preco_venda: Number(produto.preco_venda),
        quantidade: 1,
        estoque: estoqueMax
      });
    }

    salvarCarrinho();
    atualizarInterfaceCarrinho();
    mostrarToast(`"${produto.nome}" adicionado ao pedido!`);
  }

  function alterarQuantidadeCarrinho(produtoId, delta) {
    const idx = estado.carrinho.findIndex((item) => item.id === produtoId);
    if (idx === -1) return;

    const item = estado.carrinho[idx];
    const novaQtd = item.quantidade + delta;

    if (novaQtd <= 0) {
      estado.carrinho.splice(idx, 1);
    } else if (item.estoque && novaQtd > item.estoque) {
      mostrarToast(`Temos apenas ${item.estoque} unidade(s) em estoque.`);
      return;
    } else {
      item.quantidade = novaQtd;
    }

    salvarCarrinho();
    atualizarInterfaceCarrinho();
  }

  function limparCarrinho() {
    estado.carrinho = [];
    salvarCarrinho();
    atualizarInterfaceCarrinho();
  }

  function atualizarInterfaceCarrinho() {
    const contador = document.getElementById("contadorCarrinho");
    const containerItens = document.getElementById("carrinhoItens");
    const elTotal = document.getElementById("carrinhoTotalValor");
    const btnFinalizar = document.getElementById("btnFinalizarWhatsapp");
    const btnLimpar = document.getElementById("btnLimparCarrinho");

    const totalUnidades = estado.carrinho.reduce((acc, item) => acc + item.quantidade, 0);
    const valorTotal = estado.carrinho.reduce(
      (acc, item) => acc + Number(item.preco_venda) * item.quantidade,
      0
    );

    if (contador) contador.textContent = String(totalUnidades);
    if (elTotal) elTotal.textContent = formatarMoeda(valorTotal);

    if (!containerItens) return;
    containerItens.textContent = "";

    if (estado.carrinho.length === 0) {
      const msgVazio = document.createElement("div");
      msgVazio.className = "estado-lista";
      msgVazio.textContent =
        "Seu carrinho está vazio. Adicione produtos do catálogo para montar uma lista única no WhatsApp!";
      containerItens.appendChild(msgVazio);
      if (btnFinalizar) btnFinalizar.disabled = true;
      if (btnLimpar) btnLimpar.style.display = "none";
      return;
    }

    if (btnFinalizar) btnFinalizar.disabled = false;
    if (btnLimpar) btnLimpar.style.display = "block";

    estado.carrinho.forEach((item) => {
      const linha = document.createElement("div");
      linha.className = "carrinho-item";

      const info = document.createElement("div");
      info.className = "carrinho-item-info";

      const nome = document.createElement("div");
      nome.className = "carrinho-item-nome";
      nome.textContent = item.nome;

      const preco = document.createElement("div");
      preco.className = "carrinho-item-preco";
      const subtotal = Number(item.preco_venda) * item.quantidade;
      preco.textContent = `${formatarMoeda(item.preco_venda)} cada • Subtotal: ${formatarMoeda(subtotal)}`;

      info.appendChild(nome);
      info.appendChild(preco);

      const controles = document.createElement("div");
      controles.className = "carrinho-item-controles";

      const btnMenos = document.createElement("button");
      btnMenos.type = "button";
      btnMenos.className = "btn-qtd";
      btnMenos.textContent = "−";
      btnMenos.setAttribute("aria-label", "Diminuir quantidade");
      btnMenos.addEventListener("click", () => alterarQuantidadeCarrinho(item.id, -1));

      const spanQtd = document.createElement("span");
      spanQtd.className = "carrinho-qtd-num";
      spanQtd.textContent = String(item.quantidade);

      const btnMais = document.createElement("button");
      btnMais.type = "button";
      btnMais.className = "btn-qtd";
      btnMais.textContent = "+";
      btnMais.setAttribute("aria-label", "Aumentar quantidade");
      btnMais.addEventListener("click", () => alterarQuantidadeCarrinho(item.id, 1));

      controles.appendChild(btnMenos);
      controles.appendChild(spanQtd);
      controles.appendChild(btnMais);

      linha.appendChild(info);
      linha.appendChild(controles);
      containerItens.appendChild(linha);
    });
  }

  function enviarCarrinhoWhatsapp() {
    if (estado.carrinho.length === 0) return;

    if (!clienteEstaAptoParaCompra()) {
      solicitarLoginOuCadastroParaCompra({ tipo: "carrinho" });
      return;
    }

    const numero = limparNumeroWhatsapp(CFG.WHATSAPP_NUMERO);
    const nomeLoja = CFG.NOME_LOJA || "P&G Preços Justos";

    let total = 0;
    const linhasItens = estado.carrinho.map((item) => {
      const subtotal = Number(item.preco_venda) * item.quantidade;
      total += subtotal;
      return `• ${item.quantidade}x *${item.nome}* — ${formatarMoeda(subtotal)} (${formatarMoeda(item.preco_venda)} cada)`;
    });

    const mensagem = [
      `Olá, *${nomeLoja}*!`,
      `Montei meu pedido pelo catálogo online:`,
      ``,
      ...linhasItens,
      ``,
      `*Total do pedido: ${formatarMoeda(total)}*`,
      ...montarBlocoIdentificacaoCliente(),
      ``,
      `Como podemos combinar a entrega/retirada e o pagamento (Pix ou Cartão)?`
    ].join("\n");

    const url = `https://wa.me/${numero}?text=${encodeURIComponent(mensagem)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  // ==========================================================================
  // 5. EVENTOS DE INTERFACE (MENU, BUSCA, DRAWER E TOAST)
  // ==========================================================================

  let timerToast = null;
  function mostrarToast(mensagem) {
    const toast = document.getElementById("toastNotificacao");
    if (!toast) return;
    toast.textContent = mensagem;
    toast.classList.add("visivel");
    if (timerToast) clearTimeout(timerToast);
    timerToast = setTimeout(() => {
      toast.classList.remove("visivel");
    }, 2600);
  }

  function configurarEventosInterface() {
    // Menu mobile
    const btnMenu = document.getElementById("btnMenuMobile");
    const menuNav = document.getElementById("menuNavegacao");
    if (btnMenu && menuNav) {
      btnMenu.addEventListener("click", () => {
        const aberto = menuNav.classList.toggle("aberto");
        btnMenu.setAttribute("aria-expanded", aberto ? "true" : "false");
        btnMenu.textContent = aberto ? "✕" : "☰";
      });

      menuNav.querySelectorAll(".link-menu").forEach((link) => {
        link.addEventListener("click", () => {
          menuNav.classList.remove("aberto");
          btnMenu.setAttribute("aria-expanded", "false");
          btnMenu.textContent = "☰";
        });
      });
    }

    // Busca por nome
    const inputBusca = document.getElementById("inputBusca");
    const btnLimparBusca = document.getElementById("btnLimparBusca");
    if (inputBusca) {
      inputBusca.addEventListener("input", () => {
        estado.termoBusca = inputBusca.value || "";
        if (btnLimparBusca) {
          btnLimparBusca.classList.toggle("visivel", estado.termoBusca.length > 0);
        }
        renderizarVitrine();
      });
    }

    if (btnLimparBusca && inputBusca) {
      btnLimparBusca.addEventListener("click", () => {
        inputBusca.value = "";
        estado.termoBusca = "";
        btnLimparBusca.classList.remove("visivel");
        renderizarVitrine();
        inputBusca.focus();
      });
    }

    // Gaveta do carrinho
    const overlayCarrinho = document.getElementById("carrinhoOverlay");
    const btnAbrirCarrinho = document.getElementById("btnAbrirCarrinho");
    const btnFecharCarrinho = document.getElementById("btnFecharCarrinho");
    const btnFinalizar = document.getElementById("btnFinalizarWhatsapp");
    const btnLimpar = document.getElementById("btnLimparCarrinho");

    function abrirCarrinho() {
      if (!overlayCarrinho) return;
      overlayCarrinho.classList.add("aberto");
      overlayCarrinho.setAttribute("aria-hidden", "false");
    }

    function fecharCarrinho() {
      if (!overlayCarrinho) return;
      overlayCarrinho.classList.remove("aberto");
      overlayCarrinho.setAttribute("aria-hidden", "true");
    }

    if (btnAbrirCarrinho) btnAbrirCarrinho.addEventListener("click", abrirCarrinho);
    if (btnFecharCarrinho) btnFecharCarrinho.addEventListener("click", fecharCarrinho);
    if (overlayCarrinho) {
      overlayCarrinho.addEventListener("click", (e) => {
        if (e.target === overlayCarrinho) fecharCarrinho();
      });
    }

    if (btnFinalizar) btnFinalizar.addEventListener("click", enviarCarrinhoWhatsapp);
    if (btnLimpar) btnLimpar.addEventListener("click", limparCarrinho);

    // Modal de Conta do Cliente (Entrar / Cadastrar)
    const modalCliente = document.getElementById("modalContaCliente");
    const btnAbrirConta = document.getElementById("btnAbrirContaCliente");
    const btnFecharCliente = document.getElementById("btnFecharModalCliente");
    const abaEntrar = document.getElementById("abaBtnEntrar");
    const abaCadastrar = document.getElementById("abaBtnCadastrar");
    const linkIrCadastro = document.getElementById("linkIrParaCadastro");
    const formLoginCli = document.getElementById("formLoginCliente");
    const formCadCli = document.getElementById("formCadastroCliente");
    const btnSairCli = document.getElementById("btnSairContaCliente");

    function abrirModalConta(abaInicial = "entrar") {
      if (!modalCliente) return;
      exibirFeedbackCliente("");
      atualizarInterfaceContaCliente();
      if (!estado.clienteLogado) {
        alternarAbaModalCliente(abaInicial);
      }
      modalCliente.classList.add("aberto");
      modalCliente.setAttribute("aria-hidden", "false");
    }

    function fecharModalConta() {
      if (!modalCliente) return;
      modalCliente.classList.remove("aberto");
      modalCliente.setAttribute("aria-hidden", "true");
    }

    btnAbrirConta?.addEventListener("click", () => abrirModalConta("entrar"));
    btnFecharCliente?.addEventListener("click", fecharModalConta);
    modalCliente?.addEventListener("click", (e) => {
      if (e.target === modalCliente) fecharModalConta();
    });

    abaEntrar?.addEventListener("click", () => alternarAbaModalCliente("entrar"));
    abaCadastrar?.addEventListener("click", () => alternarAbaModalCliente("cadastrar"));
    linkIrCadastro?.addEventListener("click", () => alternarAbaModalCliente("cadastrar"));
    formLoginCli?.addEventListener("submit", loginClienteSubmit);
    formCadCli?.addEventListener("submit", cadastrarClienteSubmit);
    btnSairCli?.addEventListener("click", () => {
      salvarClienteLogado(null);
      alternarAbaModalCliente("entrar");
      mostrarToast("Você saiu da sua conta.");
    });

    if (window.location.hash === "#cadastro") {
      abrirModalConta("cadastrar");
    }
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

  // ==========================================================================
  // APLICATIVO (PWA): INSTALAR NO CELULAR E NO COMPUTADOR
  // ==========================================================================

  let eventoInstalacaoApp = null;

  function appJaEstaInstalado() {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true
    );
  }

  function atualizarModalInstalarApp() {
    const jaInstalado = appJaEstaInstalado();
    const elJa = document.getElementById("instalarJaInstalado");
    const elAuto = document.getElementById("instalarAutomatico");
    const elManual = document.getElementById("instalarManual");
    if (elJa) elJa.style.display = jaInstalado ? "block" : "none";
    if (elAuto) elAuto.style.display = !jaInstalado && eventoInstalacaoApp ? "block" : "none";
    if (elManual) elManual.style.display = jaInstalado || eventoInstalacaoApp ? "none" : "block";
  }

  function abrirModalInstalarApp() {
    const modal = document.getElementById("modalInstalarApp");
    if (!modal) return;
    atualizarModalInstalarApp();
    modal.classList.add("aberto");
    modal.setAttribute("aria-hidden", "false");
  }

  function fecharModalInstalarApp() {
    const modal = document.getElementById("modalInstalarApp");
    if (!modal) return;
    modal.classList.remove("aberto");
    modal.setAttribute("aria-hidden", "true");
    if (window.location.hash === "#instalar") {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }

  function configurarInstalacaoApp() {
    // Chrome/Edge/Android avisam quando o site pode ser instalado com um toque
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      eventoInstalacaoApp = e;
      atualizarModalInstalarApp();
    });

    window.addEventListener("appinstalled", () => {
      eventoInstalacaoApp = null;
      atualizarModalInstalarApp();
      mostrarToast("App instalado! Procure o ícone P&G Preços na sua tela inicial.");
    });

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch((erro) => {
        console.warn("Service worker não registrado:", erro);
      });
    }

    document.querySelectorAll(".link-instalar-app").forEach((link) => {
      link.addEventListener("click", (e) => {
        e.preventDefault();
        document.getElementById("menuNavegacao")?.classList.remove("aberto");
        abrirModalInstalarApp();
      });
    });

    document.getElementById("btnFecharModalInstalar")?.addEventListener("click", fecharModalInstalarApp);
    const modal = document.getElementById("modalInstalarApp");
    modal?.addEventListener("click", (e) => {
      if (e.target === modal) fecharModalInstalarApp();
    });

    document.getElementById("btnInstalarAgora")?.addEventListener("click", async () => {
      if (!eventoInstalacaoApp) return;
      eventoInstalacaoApp.prompt();
      await eventoInstalacaoApp.userChoice;
      eventoInstalacaoApp = null;
      atualizarModalInstalarApp();
    });

    // Link direto para divulgar: .../#instalar abre as instruções
    if (window.location.hash === "#instalar") abrirModalInstalarApp();
    window.addEventListener("hashchange", () => {
      if (window.location.hash === "#instalar") abrirModalInstalarApp();
    });
  }

  // Inicialização
  document.addEventListener("DOMContentLoaded", () => {
    configurarInstalacaoApp();
    ativarBotoesMostrarSenha();
    aplicarDadosConfigNaPagina();
    configurarEventosInterface();
    atualizarInterfaceCarrinho();
    atualizarInterfaceContaCliente();
    carregarDadosVitrine();
  });
})();

