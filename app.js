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
  const CHAVE_STORAGE_AREA_ENTREGA = "pg_precos_justos_area_entrega_v1";
  const CHAVE_STORAGE_METODO_PAGAMENTO = "pg_precos_justos_metodo_pagamento_v1";
  const CHAVE_STORAGE_AVALIACOES = "pg_precos_justos_avaliacoes_v1";
  const CHAVE_STORAGE_LOCAL_ENTREGA = "pg_precos_justos_local_entrega_v1";
  const MODO_ENTREGA_CASA = "entrega";
  const AREA_RETIRADA = "retirada";
  let supabaseInstancia = null;

  // Lista limpa de bairros para seleção individual no cadastro e no cálculo de entrega
  const BAIRROS_SALVADOR_E_RMS = [
    "Centro",
    "Nazaré",
    "Barris",
    "Campo Grande",
    "Graça",
    "Barra",
    "Ondina",
    "Rio Vermelho",
    "Federação",
    "Engenho Velho de Brotas",
    "Brotas",
    "Acupe de Brotas",
    "Horto Florestal",
    "Candeal",
    "Itaigara",
    "Pituba",
    "Parque Bela Vista",
    "Caminho das Árvores",
    "Costa Azul",
    "Stiep",
    "Armação",
    "Jardim Armação",
    "Boca do Rio",
    "Imbuí",
    "Patamares",
    "Piatã",
    "Itapuã",
    "Stella Maris",
    "Flamengo",
    "Paralela",
    "Cabula",
    "Resgate",
    "Pernambués",
    "Saramandaia",
    "Narandiba",
    "Saboeiro",
    "Tancredo Neves",
    "Sussuarana",
    "Novo Horizonte",
    "Mata Escura",
    "São Gonçalo",
    "Pau da Lima",
    "São Marcos",
    "São Rafael",
    "Castelo Branco",
    "Cajazeiras",
    "Águas Claras",
    "Valéria",
    "Liberdade",
    "Caixa D'Água",
    "IAPI",
    "Pero Vaz",
    "Santa Mônica",
    "Cidade Nova",
    "Comércio",
    "Calçada",
    "Mares",
    "Roma",
    "Bonfim",
    "Monte Serrat",
    "Ribeira",
    "Massaranduba",
    "Uruguai",
    "Fazenda Grande do Retiro",
    "São Caetano",
    "Lobato",
    "Plataforma",
    "Itacaranha",
    "Escada",
    "Periperi",
    "Praia Grande",
    "Coutos",
    "Paripe",
    "São Tomé de Paripe",
    "Vilas do Atlântico",
    "Buraquinho",
    "Ipitanga",
    "Itinga",
    "Centro (Lauro de Freitas)",
    "Caji",
    "Portão",
    "Abrantes"
  ];

  // Mapa padrão de subcategorias organizadas (Cômodos, Masculino/Feminino, Bebidas, etc.)
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
    "bebidas": ["Bebidas Alcoólicas", "Refrigerantes e Sucos", "Águas e Energéticos"],
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
    areasEntrega: [],
    areaEntregaSelecionada: carregarAreaEntregaSalva(),
    localizacaoEntrega: carregarLocalizacaoEntregaSalva(),
    metodoPagamentoSelecionado: carregarMetodoPagamentoSalvo(),
    checkMaiorIdadeConfirmado: false,
    avaliacoesPorProduto: carregarAvaliacoesLocais(),
    produtoModalAvaliacaoAtual: null,
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

    // Áreas de entrega sincronizadas do banco (se houver)
    try {
      const { data, error } = await supabaseInstancia
        .from("areas_entrega")
        .select("id, nome, valor, gratis_acima")
        .eq("ativa", true)
        .order("ordem", { ascending: true })
        .order("nome", { ascending: true });
      if (error) throw error;
      estado.areasEntrega = Array.isArray(data) ? data : [];
    } catch (erro) {
      console.warn("Áreas de entrega personalizadas indisponíveis:", erro);
      estado.areasEntrega = [];
    }

    await carregarAvaliacoesBanco();
    popularSelectBairrosCadastroCliente();
    atualizarInterfaceCarrinho();

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

    // Subcategorias arquivadas (e os produtos delas) também saem da vitrine
    const subsArquivadasPorCategoria = new Map(
      estado.categorias
        .filter((c) => Array.isArray(c.subcategorias_arquivadas) && c.subcategorias_arquivadas.length > 0)
        .map((c) => [String(c.id), new Set(c.subcategorias_arquivadas)])
    );
    if (subsArquivadasPorCategoria.size > 0) {
      estado.produtos = estado.produtos.filter((p) => {
        const arquivadas = subsArquivadasPorCategoria.get(String(p.categoria_id));
        return !arquivadas || !arquivadas.has(String(p.subcategoria || "").trim());
      });
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

    document.title = `${nomeLoja} | Loja Online — Pix e Cartão com Entrega ou Retirada`;

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

    // WhatsApp exclusivo para tirar dúvidas
    const msgDuvidas = encodeURIComponent(
      `Olá! Vim pelo site da *${nomeLoja}* e gostaria de tirar uma dúvida.`
    );
    const urlWaDuvidas = `https://wa.me/${numeroLimpo}?text=${msgDuvidas}`;

    const btnFlutuante = document.getElementById("btnWhatsappFlutuante");
    const linkWaRodape = document.getElementById("linkWhatsappRodape");
    const linkInstaRodape = document.getElementById("linkInstagramRodape");

    if (btnFlutuante) btnFlutuante.href = urlWaDuvidas;
    if (linkWaRodape) {
      linkWaRodape.href = urlWaDuvidas;
      linkWaRodape.textContent = `Dúvidas no WhatsApp: ${whatsappExibicao}`;
    }
    if (linkInstaRodape) {
      linkInstaRodape.href = instagramUrl;
      linkInstaRodape.textContent = `Instagram: @${instagramUsuario}`;
    }
  }

  function obterSubcategoriasDaCategoria(cat) {
    if (!cat) return [];
    const arquivadas = Array.isArray(cat.subcategorias_arquivadas) ? cat.subcategorias_arquivadas : [];
    if (Array.isArray(cat.subcategorias) && cat.subcategorias.length > 0) {
      return cat.subcategorias.filter((s) => !arquivadas.includes(s));
    }
    const padrao = SUBCATEGORIAS_PADRAO_POR_SLUG[cat.slug] || [];
    // Adiciona eventuais subcategorias cadastradas nos produtos dessa categoria
    const extrasProdutos = estado.produtos
      .filter((p) => String(p.categoria_id) === String(cat.id) && p.subcategoria)
      .map((p) => String(p.subcategoria).trim());
    return Array.from(new Set([...padrao, ...extrasProdutos]))
      .filter(Boolean)
      .filter((s) => !arquivadas.includes(s));
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
   * Retorna todas as URLs de fotos de um produto (suporta fotos ilimitadas)
   */
  function obterListaFotosProduto(produto) {
    const urls = [];
    if (produto && produto.foto_url && /^https?:\/\//i.test(String(produto.foto_url).trim())) {
      urls.push(String(produto.foto_url).trim());
    }
    if (produto && Array.isArray(produto.fotos_urls)) {
      produto.fotos_urls.forEach((u) => {
        const limpa = String(u || "").trim();
        if (/^https?:\/\//i.test(limpa) && !urls.includes(limpa)) {
          urls.push(limpa);
        }
      });
    }
    if (urls.length === 0) {
      urls.push(obterFotoSegura(""));
    }
    return urls;
  }

  /**
   * Identifica se o produto exige maioridade (+18 anos) — ex.: Bebidas Alcoólicas
   */
  function produtoEhMaiorIdade(produto) {
    if (!produto) return false;
    if (produto.maior_idade === true) return true;
    const texto = [
      produto.categoria_nome || "",
      produto.subcategoria || "",
      produto.nome || ""
    ]
      .join(" ")
      .toLowerCase();
    return (
      texto.includes("alcoól") ||
      texto.includes("alcool") ||
      texto.includes("cerveja") ||
      texto.includes("vinho") ||
      texto.includes("whisky") ||
      texto.includes("vodka") ||
      texto.includes("cachaça") ||
      texto.includes("cachaca") ||
      texto.includes("gin ") ||
      texto.includes("licor") ||
      texto.includes("espumante") ||
      texto.includes("tequila")
    );
  }

  /**
   * Constrói o card de um produto de forma 100% segura contra XSS (usando createElement e textContent)
   * Observação: a comparação de preço de mercado fica restrita apenas ao painel Admin.
   */
  function criarCardProduto(produto) {
    const statusEstoque = avaliarStatusEstoque(produto.estoque);
    const fotos = obterListaFotosProduto(produto);
    const ehMaior18 = produtoEhMaiorIdade(produto);
    let indiceFotoAtual = 0;

    const artigo = document.createElement("article");
    artigo.className = "produto-card" + (statusEstoque.esgotado ? " esgotado" : "");

    // 1. Mídia (Imagem inteira sem cortes + navegação de fotos se houver várias + selos)
    const divMidia = document.createElement("div");
    divMidia.className = "produto-midia";

    const img = document.createElement("img");
    img.src = fotos[0];
    img.alt = produto.nome || "Produto";
    img.loading = "lazy";
    img.decoding = "async";
    img.style.cursor = "pointer";
    img.title = "Toque para ver fotos e avaliações";
    img.addEventListener("error", () => {
      img.src = obterFotoSegura("");
    });
    img.addEventListener("click", () => abrirModalAvaliacoesProduto(produto));
    divMidia.appendChild(img);

    if (fotos.length > 1) {
      const badgeFotos = document.createElement("span");
      badgeFotos.className = "badge-fotos-count";
      badgeFotos.textContent = `1/${fotos.length}`;

      const btnAnt = document.createElement("button");
      btnAnt.type = "button";
      btnAnt.className = "btn-foto-card-nav esq";
      btnAnt.textContent = "‹";
      btnAnt.setAttribute("aria-label", "Foto anterior");
      btnAnt.addEventListener("click", (e) => {
        e.stopPropagation();
        indiceFotoAtual = (indiceFotoAtual - 1 + fotos.length) % fotos.length;
        img.src = fotos[indiceFotoAtual];
        badgeFotos.textContent = `${indiceFotoAtual + 1}/${fotos.length}`;
      });

      const btnProx = document.createElement("button");
      btnProx.type = "button";
      btnProx.className = "btn-foto-card-nav dir";
      btnProx.textContent = "›";
      btnProx.setAttribute("aria-label", "Próxima foto");
      btnProx.addEventListener("click", (e) => {
        e.stopPropagation();
        indiceFotoAtual = (indiceFotoAtual + 1) % fotos.length;
        img.src = fotos[indiceFotoAtual];
        badgeFotos.textContent = `${indiceFotoAtual + 1}/${fotos.length}`;
      });

      divMidia.appendChild(btnAnt);
      divMidia.appendChild(btnProx);
      divMidia.appendChild(badgeFotos);
    }

    const divSelos = document.createElement("div");
    divSelos.className = "produto-selos-topo";

    const spanEsq = document.createElement("span");
    if (ehMaior18) {
      spanEsq.className = "selo selo-maior-idade";
      spanEsq.textContent = "🔞 +18";
    } else if (produto.destaque) {
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
    titulo.className = "produto-nome produto-titulo";
    titulo.textContent = produto.nome;
    divCorpo.appendChild(titulo);

    // Botão de avaliações dos clientes
    const resumoAval = obterResumoAvaliacoesProduto(produto.id);
    const btnAval = document.createElement("button");
    btnAval.type = "button";
    btnAval.className = "btn-avaliacoes-card";
    btnAval.textContent =
      resumoAval.total > 0
        ? `⭐ ${resumoAval.mediaFormatada} (${resumoAval.total})`
        : "⭐ Avaliar";
    btnAval.addEventListener("click", () => abrirModalAvaliacoesProduto(produto));
    divCorpo.appendChild(btnAval);

    if (produto.descricao) {
      const desc = document.createElement("p");
      desc.className = "produto-descricao";
      desc.textContent = produto.descricao;
      divCorpo.appendChild(desc);
    }

    // 3. Bloco de Preço (sem exibir comparativo de mercado para o cliente; fica restrito ao Admin)
    const blocoPreco = document.createElement("div");
    blocoPreco.className = "produto-bloco-preco produto-preco-bloco";

    const linhaPrincipal = document.createElement("div");
    linhaPrincipal.className = "preco-linha-principal";

    const spanPrecoVenda = document.createElement("span");
    spanPrecoVenda.className = "preco-venda-valor preco-nosso-valor";
    spanPrecoVenda.textContent = formatarMoeda(produto.preco_venda);
    linhaPrincipal.appendChild(spanPrecoVenda);

    blocoPreco.appendChild(linhaPrincipal);
    divCorpo.appendChild(blocoPreco);

    // 4. Botões de Ação ("Comprar Agora" direto no site e "Adicionar ao Carrinho")
    const divAcoes = document.createElement("div");
    divAcoes.className = "produto-acoes";

    const btnComprarAgora = document.createElement("button");
    btnComprarAgora.type = "button";
    btnComprarAgora.className = "btn-pedir-whatsapp btn-card-whats";

    const btnCarrinho = document.createElement("button");
    btnCarrinho.type = "button";
    btnCarrinho.className = "btn-adicionar-carrinho btn-card-carrinho";

    if (statusEstoque.esgotado) {
      btnComprarAgora.disabled = true;
      btnComprarAgora.textContent = "Produto Esgotado";
      btnCarrinho.disabled = true;
      btnCarrinho.textContent = "Indisponível";
    } else {
      btnComprarAgora.textContent = "🛍️ Comprar Agora";
      btnComprarAgora.addEventListener("click", () => comprarAgoraProduto(produto));

      btnCarrinho.textContent = "🛒 + Carrinho";
      btnCarrinho.addEventListener("click", () => adicionarAoCarrinho(produto));
    }

    divAcoes.appendChild(btnComprarAgora);
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
  // 4. COMPRA DIRETA NO SITE, CÁLCULO DE ENTREGA/TAXA, +18 E AVALIAÇÕES
  // ==========================================================================

  function calcularIdadeAnos(dataIso) {
    const d = parseDataLocal(dataIso);
    if (!d) return null;
    const hoje = new Date();
    let idade = hoje.getFullYear() - d.getFullYear();
    const m = hoje.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && hoje.getDate() < d.getDate())) {
      idade -= 1;
    }
    return idade;
  }

  function formatarDataBR(dataIso) {
    const d = parseDataLocal(dataIso);
    if (!d) return "Não informada";
    const dia = String(d.getDate()).padStart(2, "0");
    const mes = String(d.getMonth() + 1).padStart(2, "0");
    const ano = d.getFullYear();
    return `${dia}/${mes}/${ano}`;
  }

  function carrinhoTemProdutoMaiorIdade() {
    return estado.carrinho.some((item) => {
      if (item.maior_idade === true) return true;
      const prodCat = estado.produtos.find((p) => String(p.id) === String(item.id));
      return produtoEhMaiorIdade(prodCat || item);
    });
  }

  function clienteEstaAptoParaCompra() {
    return Boolean(
      estado.clienteLogado &&
        estado.clienteLogado.nome &&
        String(estado.clienteLogado.endereco || "").trim().length >= 5
    );
  }

  function solicitarLoginOuCadastroParaCompra(acaoPendente, msgPersonalizada) {
    estado.acaoPendenteCompra = acaoPendente;

    const overlayCarrinho = document.getElementById("carrinhoOverlay");
    if (overlayCarrinho) {
      overlayCarrinho.classList.remove("aberto");
      overlayCarrinho.setAttribute("aria-hidden", "true");
    }

    const modalCliente = document.getElementById("modalContaCliente");
    if (modalCliente) {
      atualizarInterfaceContaCliente();
      if (!estado.clienteLogado) {
        alternarAbaModalCliente("cadastrar");
      }
      exibirFeedbackCliente(
        msgPersonalizada ||
          "🔒 Para finalizar sua compra, faça login ou cadastre-se informando data de nascimento e endereço completo.",
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
      comprarAgoraProduto(acao.produto);
    } else if (acao.tipo === "carrinho") {
      const overlayCarrinho = document.getElementById("carrinhoOverlay");
      if (overlayCarrinho) {
        overlayCarrinho.classList.add("aberto");
        overlayCarrinho.setAttribute("aria-hidden", "false");
      }
      iniciarFinalizacaoCompraSite();
    }
  }

  function comprarAgoraProduto(produto) {
    const estoqueMax = Math.max(0, parseInt(produto.estoque, 10) || 0);
    if (estoqueMax <= 0) {
      mostrarToast("Produto esgotado.");
      return;
    }

    const existente = estado.carrinho.find((item) => item.id === produto.id);
    if (!existente) {
      estado.carrinho.push({
        id: produto.id,
        nome: produto.nome,
        preco_venda: Number(produto.preco_venda),
        quantidade: 1,
        estoque: estoqueMax,
        maior_idade: produtoEhMaiorIdade(produto)
      });
      salvarCarrinho();
      atualizarInterfaceCarrinho();
    }

    const overlayCarrinho = document.getElementById("carrinhoOverlay");
    if (overlayCarrinho) {
      overlayCarrinho.classList.add("aberto");
      overlayCarrinho.setAttribute("aria-hidden", "false");
    }
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
        // Sincroniza automaticamente País, Estado, Cidade e Bairro do cliente logado com o calculador de entregas
        sincronizarLocalizacaoComClienteLogado(cliente);
      } else {
        localStorage.removeItem(CHAVE_STORAGE_CLIENTE);
      }
    } catch (_) {}
    atualizarInterfaceContaCliente();
    atualizarInterfaceCarrinho();
  }

  function carregarLocalizacaoEntregaSalva() {
    try {
      const bruto = localStorage.getItem(CHAVE_STORAGE_LOCAL_ENTREGA);
      if (bruto) {
        const lido = JSON.parse(bruto);
        if (lido && typeof lido === "object") {
          return {
            pais: lido.pais || "Brasil",
            estado: lido.estado || "BA",
            cidade: lido.cidade || "Salvador",
            bairro: lido.bairro || ""
          };
        }
      }
    } catch (_) {}
    return {
      pais: "Brasil",
      estado: "BA",
      cidade: "Salvador",
      bairro: ""
    };
  }

  function salvarLocalizacaoEntrega() {
    try {
      localStorage.setItem(
        CHAVE_STORAGE_LOCAL_ENTREGA,
        JSON.stringify(estado.localizacaoEntrega)
      );
    } catch (_) {}
  }

  function sincronizarLocalizacaoComClienteLogado(cliente) {
    if (!cliente) return;
    if (cliente.pais) estado.localizacaoEntrega.pais = cliente.pais;
    if (cliente.estado) estado.localizacaoEntrega.estado = cliente.estado;
    if (cliente.cidade) estado.localizacaoEntrega.cidade = cliente.cidade;
    if (cliente.bairro) {
      estado.localizacaoEntrega.bairro = cliente.bairro;
    } else if (cliente.endereco) {
      // Se o cliente tinha endereço antigo em texto, tenta identificar o bairro cadastrado
      const endLower = String(cliente.endereco).toLowerCase();
      const bairroAchado = BAIRROS_SALVADOR_E_RMS.find((b) =>
        endLower.includes(b.toLowerCase())
      );
      if (bairroAchado) {
        estado.localizacaoEntrega.bairro = bairroAchado;
      }
    }
    salvarLocalizacaoEntrega();
  }

  function popularSelectBairrosCadastroCliente() {
    const nomesAreas = (estado.areasEntrega || [])
      .map((a) => String(a.nome || "").trim())
      .filter((n) => n && !n.includes("/"));
    const todosBairros = Array.from(new Set([...BAIRROS_SALVADOR_E_RMS, ...nomesAreas]));

    // 1. Select de bairro do formulário de Cadastro de Cliente
    const selectBairro = document.getElementById("cadClienteBairro");
    if (selectBairro) {
      const valorAtual = selectBairro.value;
      selectBairro.textContent = "";
      const optPadrao = document.createElement("option");
      optPadrao.value = "";
      optPadrao.textContent = "Selecione seu bairro...";
      selectBairro.appendChild(optPadrao);

      todosBairros.forEach((b) => {
        const opt = document.createElement("option");
        opt.value = b.trim();
        opt.textContent = b.trim();
        selectBairro.appendChild(opt);
      });

      const optOutro = document.createElement("option");
      optOutro.value = "__outro__";
      optOutro.textContent = "Outro bairro (digitar)...";
      selectBairro.appendChild(optOutro);

      if (valorAtual) selectBairro.value = valorAtual;
    }

    // 2. Select de bairro do Calculador Sincronizado de Entrega no Carrinho
    const selectCalcBairro = document.getElementById("carrinhoCalcBairro");
    if (selectCalcBairro) {
      const bairroSalvo = estado.localizacaoEntrega?.bairro || selectCalcBairro.value || "";
      selectCalcBairro.textContent = "";
      const opt0 = document.createElement("option");
      opt0.value = "";
      opt0.textContent = "Selecione o bairro...";
      selectCalcBairro.appendChild(opt0);

      todosBairros.forEach((b) => {
        const limpo = b.trim();
        const opt = document.createElement("option");
        opt.value = limpo;
        opt.textContent = limpo;
        selectCalcBairro.appendChild(opt);
      });

      if (
        bairroSalvo &&
        !todosBairros.some((b) => b.trim().toLowerCase() === bairroSalvo.toLowerCase())
      ) {
        const optPersonalizado = document.createElement("option");
        optPersonalizado.value = bairroSalvo;
        optPersonalizado.textContent = bairroSalvo;
        selectCalcBairro.appendChild(optPersonalizado);
      }

      const optOutroCalc = document.createElement("option");
      optOutroCalc.value = "Outro bairro";
      optOutroCalc.textContent = "Outro bairro da cidade";
      selectCalcBairro.appendChild(optOutroCalc);

      selectCalcBairro.value = bairroSalvo;
    }
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

        const elDataNasc = document.getElementById("perfilClienteDataNasc");
        const boxAtualizarNasc = document.getElementById("boxAtualizarDataNascLogado");
        if (estado.clienteLogado.data_nascimento) {
          const idade = calcularIdadeAnos(estado.clienteLogado.data_nascimento);
          if (elDataNasc) {
            elDataNasc.textContent = `${formatarDataBR(estado.clienteLogado.data_nascimento)}${
              idade !== null ? ` (${idade} anos)` : ""
            }`;
          }
          if (boxAtualizarNasc) boxAtualizarNasc.style.display = "none";
        } else {
          if (elDataNasc) elDataNasc.textContent = "Não informada (necessária para bebidas +18)";
          if (boxAtualizarNasc) boxAtualizarNasc.style.display = "block";
        }
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
      popularSelectBairrosCadastroCliente();
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
    const dataNascimento = String(document.getElementById("cadClienteDataNasc")?.value || "").trim();
    const pais = String(document.getElementById("cadClientePais")?.value || "Brasil").trim();
    const estadoUf = String(document.getElementById("cadClienteEstado")?.value || "BA").trim();
    const cidadeSel = String(document.getElementById("cadClienteCidade")?.value || "").trim();
    const cidadeOutra = String(document.getElementById("cadClienteCidadeOutra")?.value || "").trim();
    const cidade = cidadeSel === "__outra__" ? cidadeOutra : cidadeSel;

    const bairroSel = String(document.getElementById("cadClienteBairro")?.value || "").trim();
    const bairroOutro = String(document.getElementById("cadClienteBairroOutro")?.value || "").trim();
    const bairro = bairroSel === "__outro__" ? bairroOutro : bairroSel;

    const rua = String(document.getElementById("cadClienteRua")?.value || "").trim();
    const complemento = String(document.getElementById("cadClienteComplemento")?.value || "").trim();
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
    if (!dataNascimento || calcularIdadeAnos(dataNascimento) === null) {
      exibirFeedbackCliente("Por favor, informe sua data de nascimento válida.");
      return;
    }
    if (!pais || !estadoUf || !cidade) {
      exibirFeedbackCliente("Selecione País, Estado e Cidade.");
      return;
    }
    if (!bairro) {
      exibirFeedbackCliente("Selecione ou informe seu Bairro.");
      return;
    }
    if (rua.length < 3) {
      exibirFeedbackCliente("Informe sua Rua e Número.");
      return;
    }
    if (senha.length < 6) {
      exibirFeedbackCliente("A senha deve ter pelo menos 6 caracteres.");
      return;
    }

    const endereco = `${rua}${complemento ? " (" + complemento + ")" : ""} - ${bairro}, ${cidade}/${estadoUf} - ${pais}`;

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
          p_senha: senha,
          p_data_nascimento: dataNascimento,
          p_pais: pais,
          p_estado: estadoUf,
          p_cidade: cidade,
          p_bairro: bairro,
          p_rua: rua,
          p_complemento: complemento
        });

        if (error) {
          // Tenta chamada compatível com versão anterior da RPC (5 parâmetros) caso o SQL novo ainda não tenha rodado
          const resAntigo = await supabaseInstancia.rpc("cadastrar_cliente_loja", {
            p_nome: nome,
            p_email: email,
            p_whatsapp: whatsapp,
            p_endereco: endereco,
            p_senha: senha
          });
          if (!resAntigo.error && resAntigo.data) {
            dadosCliente = {
              ...resAntigo.data,
              data_nascimento: dataNascimento,
              pais,
              estado: estadoUf,
              cidade,
              bairro,
              rua,
              complemento
            };
          } else if (
            String(error.message || "").includes("cadastrar_cliente_loja") ||
            String(error.code || "") === "PGRST202"
          ) {
            dadosCliente = cadastrarClienteLocalFallback({
              nome,
              email,
              whatsapp,
              endereco,
              senha,
              data_nascimento: dataNascimento,
              pais,
              estado: estadoUf,
              cidade,
              bairro,
              rua,
              complemento
            });
          } else {
            throw new Error(resAntigo.error?.message || error.message);
          }
        } else {
          dadosCliente = {
            ...data,
            data_nascimento: data?.data_nascimento || dataNascimento
          };
        }
      } else {
        dadosCliente = cadastrarClienteLocalFallback({
          nome,
          email,
          whatsapp,
          endereco,
          senha,
          data_nascimento: dataNascimento,
          pais,
          estado: estadoUf,
          cidade,
          bairro,
          rua,
          complemento
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

  function cadastrarClienteLocalFallback(dados) {
    let lista = [];
    try {
      lista = JSON.parse(localStorage.getItem(CHAVE_STORAGE_CONTAS_LOCAIS) || "[]");
    } catch (_) {
      lista = [];
    }
    if (lista.some((c) => c.email === dados.email)) {
      throw new Error("Este e-mail já está cadastrado. Acesse a aba Entrar.");
    }
    const novo = {
      id: "cli-" + Date.now(),
      ...dados
    };
    lista.push(novo);
    try {
      localStorage.setItem(CHAVE_STORAGE_CONTAS_LOCAIS, JSON.stringify(lista));
    } catch (_) {}
    const copiaSegura = { ...novo };
    delete copiaSegura.senha;
    return copiaSegura;
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
    const copiaSegura = { ...encontrado };
    delete copiaSegura.senha;
    return copiaSegura;
  }

  function carregarAreaEntregaSalva() {
    try {
      const salvo = localStorage.getItem(CHAVE_STORAGE_AREA_ENTREGA) || "";
      if (salvo === MODO_ENTREGA_CASA || salvo === AREA_RETIRADA) return salvo;
      return "";
    } catch (_) {
      return "";
    }
  }

  function salvarAreaEntrega() {
    try {
      localStorage.setItem(CHAVE_STORAGE_AREA_ENTREGA, estado.areaEntregaSelecionada || "");
    } catch (_) {}
  }

  function carregarMetodoPagamentoSalvo() {
    try {
      return localStorage.getItem(CHAVE_STORAGE_METODO_PAGAMENTO) || "pix";
    } catch (_) {
      return "pix";
    }
  }

  function salvarMetodoPagamento() {
    try {
      localStorage.setItem(CHAVE_STORAGE_METODO_PAGAMENTO, estado.metodoPagamentoSelecionado || "pix");
    } catch (_) {}
  }

  /**
   * Calcula a taxa de entrega com base no País, Estado, Cidade e Bairro onde o cliente está,
   * sincronizado com as regras da Plataforma de Entregas e com a tabela areas_entrega do Admin.
   */
  function calcularCotacaoEntregaPorLocalizacao(subtotalProdutos) {
    const loc = estado.localizacaoEntrega || {
      pais: "Brasil",
      estado: "BA",
      cidade: "Salvador",
      bairro: ""
    };
    const pais = String(loc.pais || "Brasil").trim();
    const uf = String(loc.estado || "BA").trim().toUpperCase();
    const cidade = String(loc.cidade || "Salvador").trim();
    const bairro = String(loc.bairro || "").trim();
    const nomePlataforma = CFG.PLATAFORMA_ENTREGA_NOME || "Plataforma de Entregas";

    // 1. Verifica se há regra personalizada cadastrada pelo Admin em areas_entrega para este bairro/cidade
    if (bairro && Array.isArray(estado.areasEntrega) && estado.areasEntrega.length > 0) {
      const areaMatch = estado.areasEntrega.find((a) => {
        const nomeArea = String(a.nome || "").toLowerCase();
        return (
          nomeArea === bairro.toLowerCase() ||
          nomeArea.includes(bairro.toLowerCase())
        );
      });
      if (areaMatch) {
        const gratisAcima =
          areaMatch.gratis_acima !== null && areaMatch.gratis_acima !== undefined
            ? Number(areaMatch.gratis_acima)
            : null;
        const valor =
          gratisAcima !== null && subtotalProdutos >= gratisAcima
            ? 0
            : Number(areaMatch.valor) || 0;
        return {
          pronto: true,
          valor,
          gratisAcima,
          descricaoDestino: `${bairro}, ${cidade}/${uf} - ${pais}`,
          plataforma: nomePlataforma
        };
      }
    }

    // 2. Cálculo baseado no País, Estado, Cidade e Bairro (sincronizado com a plataforma de entregas)
    if (pais.toLowerCase() !== "brasil") {
      return {
        pronto: true,
        valor: 149.9,
        gratisAcima: null,
        descricaoDestino: `${cidade} (${pais})`,
        plataforma: `${nomePlataforma} Internacional`
      };
    }

    // Outros estados do Brasil fora da Bahia (Envio Nacional via Plataforma / Transportadora / Correios)
    if (uf !== "BA") {
      const estadosNordeste = ["SE", "AL", "PE", "PB", "RN", "CE", "PI", "MA"];
      const estadosSudesteCentro = ["SP", "RJ", "MG", "ES", "DF", "GO", "MS", "MT", "TO"];
      let valorEstadual = 38.9;
      if (estadosNordeste.includes(uf)) valorEstadual = 24.9;
      else if (estadosSudesteCentro.includes(uf)) valorEstadual = 32.9;

      return {
        pronto: true,
        valor: valorEstadual,
        gratisAcima: 299.0,
        descricaoDestino: `${bairro ? bairro + ", " : ""}${cidade}/${uf} - ${pais}`,
        plataforma: nomePlataforma
      };
    }

    // Dentro da Bahia (BA): verifica Cidade e Bairro
    const cidadeLower = cidade.toLowerCase();
    if (cidadeLower === "salvador" || cidadeLower === "lauro de freitas") {
      if (!bairro) {
        return {
          pronto: false,
          valor: 0,
          gratisAcima: null,
          descricaoDestino: `${cidade}/${uf} - ${pais}`,
          plataforma: nomePlataforma
        };
      }

      const bLower = bairro.toLowerCase();
      const zonaCentral = ["centro", "nazaré", "barris", "campo grande", "graça", "comércio", "calçada", "mares", "roma", "bonfim", "ribeira", "liberdade", "cidade nova", "caixa d'água"];
      const zonaSulBrotas = ["barra", "ondina", "rio vermelho", "federação", "brotas", "engenho velho de brotas", "acupe de brotas", "horto florestal", "candeal", "itaigara", "pituba", "parque bela vista", "caminho das árvores", "costa azul", "stiep", "armação", "jardim armação"];
      const zonaCabulaParalela = ["cabula", "resgate", "pernambués", "saramandaia", "narandiba", "saboeiro", "tancredo neves", "sussuarana", "mata escura", "pau da Lima", "são marcos", "são rafael", "paralela", "imbuí", "boca do rio", "patamares", "piatã"];

      let taxaBairro = 14.0;
      let gratisAcima = 180.0;

      if (cidadeLower === "lauro de freitas" || ["vilas do atlântico", "buraquinho", "ipitanga", "itinga", "centro (lauro de freitas)", "caji", "portão", "abrantes"].includes(bLower)) {
        taxaBairro = 18.0;
        gratisAcima = 220.0;
      } else if (zonaCentral.includes(bLower)) {
        taxaBairro = 8.0;
        gratisAcima = 120.0;
      } else if (zonaSulBrotas.includes(bLower)) {
        taxaBairro = 11.0;
        gratisAcima = 150.0;
      } else if (zonaCabulaParalela.includes(bLower)) {
        taxaBairro = 12.0;
        gratisAcima = 160.0;
      }

      const valorFinal = subtotalProdutos >= gratisAcima ? 0 : taxaBairro;
      return {
        pronto: true,
        valor: valorFinal,
        gratisAcima,
        descricaoDestino: `${bairro}, ${cidade}/${uf} - ${pais}`,
        plataforma: nomePlataforma
      };
    }

    // Demais cidades da Região Metropolitana ou Interior da Bahia
    const rmsCidades = ["camaçari", "simões filho", "candeias"];
    const taxaCidadeBa = rmsCidades.includes(cidadeLower) ? 19.9 : 22.9;
    return {
      pronto: true,
      valor: subtotalProdutos >= 250 ? 0 : taxaCidadeBa,
      gratisAcima: 250.0,
      descricaoDestino: `${bairro ? bairro + ", " : ""}${cidade}/${uf} - ${pais}`,
      plataforma: nomePlataforma
    };
  }

  function calcularTaxaPagamento(valorBase) {
    if (estado.metodoPagamentoSelecionado === "cartao") {
      const pct = Number(CFG.TAXA_CARTAO_MERCADO_PAGO_PCT) || 4.99;
      return Number(((valorBase * pct) / 100).toFixed(2));
    }
    return 0;
  }

  function renderizarEntregaCarrinho(subtotalProdutos) {
    const bloco = document.getElementById("blocoEntregaCarrinho");
    const select = document.getElementById("selectAreaEntrega");
    const blocoEnderecoCalc = document.getElementById("blocoEnderecoCalculoEntrega");
    const elResumoPlataforma = document.getElementById("resumoPlataformaEntrega");
    const aviso = document.getElementById("avisoAreaEntrega");
    const linhasFrete = document.getElementById("linhasFreteCarrinho");
    const avisoPagamento = document.getElementById("carrinhoAvisoPagamento");
    const blocoPagamento = document.getElementById("blocoMetodoPagamentoCarrinho");
    const selectPag = document.getElementById("selectMetodoPagamentoCarrinho");
    const avisoTaxaPag = document.getElementById("avisoTaxaPagamentoCarrinho");
    const blocoMaior18 = document.getElementById("blocoConfirmacaoMaiorIdadeCarrinho");
    const exibir = estado.carrinho.length > 0;

    if (bloco) bloco.style.display = exibir ? "block" : "none";
    if (blocoPagamento) blocoPagamento.style.display = exibir ? "block" : "none";
    if (linhasFrete) linhasFrete.style.display = exibir ? "block" : "none";

    const exigeMaior18 = exibir && carrinhoTemProdutoMaiorIdade();
    if (blocoMaior18) {
      blocoMaior18.style.display = exigeMaior18 ? "block" : "none";
    }

    // Sincroniza localização do cliente logado caso ainda esteja vazia
    if (estado.clienteLogado && !estado.localizacaoEntrega.bairro) {
      sincronizarLocalizacaoComClienteLogado(estado.clienteLogado);
    }

    // O select de recebimento tem APENAS "Entrega em casa" e "Retirada no local"
    if (select) {
      select.textContent = "";
      const opcoes = [
        { valor: "", texto: "Selecione: Entrega em casa ou Retirada..." },
        { valor: MODO_ENTREGA_CASA, texto: "🚚 Entrega em casa" },
        { valor: AREA_RETIRADA, texto: "🏪 Retirada no local (Grátis)" }
      ];
      opcoes.forEach((op) => {
        const opt = document.createElement("option");
        opt.value = op.valor;
        opt.textContent = op.texto;
        select.appendChild(opt);
      });
      select.value = estado.areaEntregaSelecionada || "";
    }

    // Se escolheu Entrega em casa, exibe os seletores sincronizados de País, Estado, Cidade e Bairro
    const ehEntregaCasa = exibir && estado.areaEntregaSelecionada === MODO_ENTREGA_CASA;
    if (blocoEnderecoCalc) {
      blocoEnderecoCalc.style.display = ehEntregaCasa ? "block" : "none";
    }

    if (ehEntregaCasa) {
      popularSelectBairrosCadastroCliente();
      const selPais = document.getElementById("carrinhoCalcPais");
      const selEstado = document.getElementById("carrinhoCalcEstado");
      const selCidade = document.getElementById("carrinhoCalcCidade");
      const selBairro = document.getElementById("carrinhoCalcBairro");
      if (selPais) selPais.value = estado.localizacaoEntrega.pais || "Brasil";
      if (selEstado) selEstado.value = estado.localizacaoEntrega.estado || "BA";
      if (selCidade) selCidade.value = estado.localizacaoEntrega.cidade || "Salvador";
      if (selBairro) selBairro.value = estado.localizacaoEntrega.bairro || "";
    }

    if (selectPag) {
      const pctCartao = Number(CFG.TAXA_CARTAO_MERCADO_PAGO_PCT) || 4.99;
      selectPag.textContent = "";
      const optPix = document.createElement("option");
      optPix.value = "pix";
      optPix.textContent = "💠 Pix (Mercado Pago — Sem taxa extra)";
      const optCartao = document.createElement("option");
      optCartao.value = "cartao";
      optCartao.textContent = `💳 Cartão de Crédito / Débito (Mercado Pago — +${pctCartao.toLocaleString("pt-BR")}%)`;
      selectPag.appendChild(optPix);
      selectPag.appendChild(optCartao);
      selectPag.value = estado.metodoPagamentoSelecionado || "pix";
    }

    let frete = null;
    let cotacao = null;
    if (estado.areaEntregaSelecionada === AREA_RETIRADA) {
      frete = 0;
    } else if (estado.areaEntregaSelecionada === MODO_ENTREGA_CASA) {
      cotacao = calcularCotacaoEntregaPorLocalizacao(subtotalProdutos);
      frete = cotacao.pronto ? cotacao.valor : null;
    }

    if (elResumoPlataforma) {
      if (!ehEntregaCasa) {
        elResumoPlataforma.textContent = "";
      } else if (cotacao && cotacao.pronto) {
        elResumoPlataforma.textContent = `🔄 ${cotacao.plataforma} • ${cotacao.descricaoDestino}: ${
          cotacao.valor === 0 ? "Frete Grátis" : formatarMoeda(cotacao.valor)
        }`;
      } else {
        elResumoPlataforma.textContent =
          "👆 Selecione seu Bairro, Cidade, Estado e País acima para calcular o frete.";
      }
    }

    const elFrete = document.getElementById("carrinhoFreteValor");
    if (elFrete) {
      if (estado.areaEntregaSelecionada === AREA_RETIRADA) {
        elFrete.textContent = "Retirada (Grátis)";
      } else if (estado.areaEntregaSelecionada === MODO_ENTREGA_CASA) {
        if (cotacao && cotacao.pronto) {
          elFrete.textContent = cotacao.valor === 0 ? "Grátis" : formatarMoeda(cotacao.valor);
        } else {
          elFrete.textContent = "Selecione o bairro";
        }
      } else {
        elFrete.textContent = "Escolha uma opção";
      }
    }

    const baseCalculoTaxa = subtotalProdutos + (frete || 0);
    const taxaPagamento = calcularTaxaPagamento(baseCalculoTaxa);
    const elRotuloTaxa = document.getElementById("carrinhoRotuloTaxaPagamento");
    if (elRotuloTaxa) {
      elRotuloTaxa.textContent =
        estado.metodoPagamentoSelecionado === "cartao"
          ? `Taxa Cartão (${CFG.TAXA_CARTAO_MERCADO_PAGO_PCT || 4.99}%):`
          : "Taxa de pagamento (Pix):";
    }
    const elTaxaPag = document.getElementById("carrinhoTaxaPagamentoValor");
    if (elTaxaPag) {
      elTaxaPag.textContent =
        taxaPagamento > 0 ? `+ ${formatarMoeda(taxaPagamento)}` : "R$ 0,00 (Pix)";
    }

    if (avisoTaxaPag) {
      avisoTaxaPag.textContent =
        taxaPagamento > 0
          ? `Taxa do Mercado Pago (${formatarMoeda(taxaPagamento)}) somada automaticamente.`
          : "No Pix você não paga nenhuma taxa adicional.";
    }

    if (aviso) {
      const faltaParaGratis =
        cotacao &&
        cotacao.pronto &&
        cotacao.gratisAcima !== null &&
        cotacao.valor > 0
          ? Number(cotacao.gratisAcima) - subtotalProdutos
          : 0;
      aviso.textContent =
        faltaParaGratis > 0
          ? `Faltam ${formatarMoeda(faltaParaGratis)} em produtos para ganhar frete grátis na sua região!`
          : "";
    }

    if (avisoPagamento) {
      avisoPagamento.textContent =
        "Pagamento seguro via Pix ou Cartão sincronizado com Mercado Pago / Mercado Livre.";
    }

    return { frete: frete || 0, taxaPagamento };
  }

  function salvarCarrinho() {
    try {
      localStorage.setItem(CHAVE_STORAGE_CARRINHO, JSON.stringify(estado.carrinho));
    } catch (_) {}
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
      existente.maior_idade = produtoEhMaiorIdade(produto);
    } else {
      estado.carrinho.push({
        id: produto.id,
        nome: produto.nome,
        preco_venda: Number(produto.preco_venda),
        quantidade: 1,
        estoque: estoqueMax,
        maior_idade: produtoEhMaiorIdade(produto)
      });
    }

    salvarCarrinho();
    atualizarInterfaceCarrinho();
    mostrarToast(`"${produto.nome}" adicionado ao carrinho!`);
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
    const elSubtotal = document.getElementById("carrinhoSubtotalValor");
    if (elSubtotal) elSubtotal.textContent = formatarMoeda(valorTotal);
    const { frete, taxaPagamento } = renderizarEntregaCarrinho(valorTotal);
    if (elTotal) elTotal.textContent = formatarMoeda(valorTotal + frete + taxaPagamento);

    if (!containerItens) return;
    containerItens.textContent = "";

    if (estado.carrinho.length === 0) {
      const msgVazio = document.createElement("div");
      msgVazio.className = "estado-lista";
      msgVazio.textContent =
        "Seu carrinho está vazio. Clique em 'Comprar Agora' ou '+ Carrinho' nos produtos para começar!";
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
      nome.textContent = item.maior_idade ? `🔞 ${item.nome}` : item.nome;

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

  /**
   * Gera código Pix Copia e Cola padrão EMVCo para o valor total da compra
   */
  function gerarPayloadPixCopiaECola(valorTotal) {
    const chave = String(CFG.PIX_CHAVE_LOJA || "71999915480").trim();
    const favorecido = String(CFG.PIX_FAVORECIDO || "PG PRECOS JUSTOS")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .substring(0, 25)
      .toUpperCase();
    const cidade = String(CFG.PIX_CIDADE || "SALVADOR")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .substring(0, 15)
      .toUpperCase();
    const valorStr = Number(valorTotal || 0).toFixed(2);

    function tlv(id, val) {
      const tam = String(val.length).padStart(2, "0");
      return `${id}${tam}${val}`;
    }

    const gui = tlv("00", "br.gov.bcb.pix");
    const keyField = tlv("01", chave);
    const merchantAccount = tlv("26", gui + keyField);
    const txid = tlv("05", "PGPEDIDO");
    const addData = tlv("62", txid);

    const semCrc =
      tlv("00", "01") +
      merchantAccount +
      tlv("52", "0000") +
      tlv("53", "986") +
      tlv("54", valorStr) +
      tlv("58", "BR") +
      tlv("59", favorecido) +
      tlv("60", cidade) +
      addData +
      "6304";

    // Cálculo CRC16-CCITT (0xFFFF)
    let crc = 0xffff;
    for (let i = 0; i < semCrc.length; i++) {
      crc ^= semCrc.charCodeAt(i) << 8;
      for (let j = 0; j < 8; j++) {
        if ((crc & 0x8000) !== 0) {
          crc = ((crc << 1) ^ 0x1021) & 0xffff;
        } else {
          crc = (crc << 1) & 0xffff;
        }
      }
    }
    const crcHex = crc.toString(16).toUpperCase().padStart(4, "0");
    return semCrc + crcHex;
  }

  function iniciarFinalizacaoCompraSite() {
    if (estado.carrinho.length === 0) return;

    if (!clienteEstaAptoParaCompra()) {
      solicitarLoginOuCadastroParaCompra({ tipo: "carrinho" });
      return;
    }

    if (!estado.areaEntregaSelecionada) {
      mostrarToast("Escolha como quer receber (Entrega em casa ou Retirada) antes de finalizar.");
      document.getElementById("selectAreaEntrega")?.focus();
      return;
    }

    if (estado.areaEntregaSelecionada === MODO_ENTREGA_CASA) {
      const subtotal = estado.carrinho.reduce(
        (acc, item) => acc + Number(item.preco_venda) * item.quantidade,
        0
      );
      const cotacao = calcularCotacaoEntregaPorLocalizacao(subtotal);
      if (!cotacao.pronto) {
        mostrarToast(
          "📍 Selecione seu Bairro, Cidade, Estado e País para calcular a entrega antes de finalizar."
        );
        document.getElementById("carrinhoCalcBairro")?.focus();
        return;
      }
    }

    // Verificação obrigatória +18 para bebidas alcoólicas
    if (carrinhoTemProdutoMaiorIdade()) {
      const check18 = document.getElementById("checkMaiorIdadeCarrinho");
      if (!check18 || !check18.checked) {
        mostrarToast(
          "🔞 Marque a caixinha confirmando que você tem mais de 18 anos para comprar bebidas alcoólicas."
        );
        check18?.focus();
        return;
      }

      const dataNascCliente = estado.clienteLogado?.data_nascimento;
      if (!dataNascCliente) {
        solicitarLoginOuCadastroParaCompra(
          { tipo: "carrinho" },
          "🔞 Bebida alcoólica no pedido: informe sua data de nascimento no seu perfil para comprovar que você tem 18 anos ou mais."
        );
        return;
      }

      const idadeCliente = calcularIdadeAnos(dataNascCliente);
      if (idadeCliente === null || idadeCliente < 18) {
        mostrarToast(
          "🔞 Compra bloqueada: venda de bebidas alcoólicas proibida para menores de 18 anos (Lei nº 13.106/2015)."
        );
        return;
      }
    }

    abrirModalPagamentoCheckout();
  }

  function alternarAbaModalPagamento(metodo) {
    estado.metodoPagamentoSelecionado = metodo === "cartao" ? "cartao" : "pix";
    salvarMetodoPagamento();
    atualizarInterfaceCarrinho();

    const btnPix = document.getElementById("abaPagBtnPix");
    const btnCartao = document.getElementById("abaPagBtnCartao");
    const painelPix = document.getElementById("painelPagamentoPix");
    const painelCartao = document.getElementById("painelPagamentoCartao");

    if (estado.metodoPagamentoSelecionado === "cartao") {
      btnPix?.classList.remove("ativa");
      btnCartao?.classList.add("ativa");
      if (painelPix) painelPix.style.display = "none";
      if (painelCartao) painelCartao.style.display = "block";
    } else {
      btnCartao?.classList.remove("ativa");
      btnPix?.classList.add("ativa");
      if (painelCartao) painelCartao.style.display = "none";
      if (painelPix) painelPix.style.display = "block";
    }

    preencherResumoModalPagamento();
  }

  function preencherResumoModalPagamento() {
    const boxResumo = document.getElementById("resumoPagamentoCheckout");
    if (!boxResumo) return;

    const subtotalProdutos = estado.carrinho.reduce(
      (acc, item) => acc + Number(item.preco_venda) * item.quantidade,
      0
    );
    const cotacao = calcularCotacaoEntregaPorLocalizacao(subtotalProdutos);
    let frete = 0;
    if (estado.areaEntregaSelecionada === MODO_ENTREGA_CASA) {
      frete = cotacao.pronto ? cotacao.valor : 0;
    }

    const taxaPag = calcularTaxaPagamento(subtotalProdutos + frete);
    const totalFinal = subtotalProdutos + frete + taxaPag;

    boxResumo.textContent = "";

    const criarLinha = (rotulo, valor) => {
      const div = document.createElement("div");
      div.className = "resumo-pagamento-linha";
      const sp1 = document.createElement("span");
      sp1.textContent = rotulo;
      const sp2 = document.createElement("strong");
      sp2.textContent = valor;
      div.appendChild(sp1);
      div.appendChild(sp2);
      return div;
    };

    boxResumo.appendChild(criarLinha("Subtotal dos produtos:", formatarMoeda(subtotalProdutos)));
    boxResumo.appendChild(
      criarLinha(
        estado.areaEntregaSelecionada === AREA_RETIRADA
          ? "Recebimento (Retirada no local):"
          : `Entrega em casa (${cotacao.descricaoDestino}):`,
        frete === 0 ? "Grátis" : formatarMoeda(frete)
      )
    );
    boxResumo.appendChild(
      criarLinha(
        estado.metodoPagamentoSelecionado === "cartao"
          ? `Taxa Cartão Mercado Pago (${CFG.TAXA_CARTAO_MERCADO_PAGO_PCT || 4.99}%):`
          : "Taxa Pix Mercado Pago:",
        taxaPag > 0 ? `+ ${formatarMoeda(taxaPag)}` : "R$ 0,00 (isento)"
      )
    );

    const divTotal = document.createElement("div");
    divTotal.className = "resumo-pagamento-total";
    const spTot1 = document.createElement("span");
    spTot1.textContent = "Total a pagar agora:";
    const spTot2 = document.createElement("span");
    spTot2.textContent = formatarMoeda(totalFinal);
    divTotal.appendChild(spTot1);
    divTotal.appendChild(spTot2);
    boxResumo.appendChild(divTotal);

    // Atualiza QR Code e código Pix
    const payloadPix = gerarPayloadPixCopiaECola(totalFinal);
    const inputPix = document.getElementById("inputPixCopiaECola");
    if (inputPix) inputPix.value = payloadPix;

    const imgQr = document.getElementById("imgQrCodePix");
    if (imgQr) {
      imgQr.src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(
        payloadPix
      )}`;
    }

    // Atualiza texto e link do Cartão Mercado Pago
    const descCartao = document.getElementById("textoDetalheTaxaCartao");
    if (descCartao) {
      descCartao.textContent = `Valor no Cartão com a taxa do Mercado Pago inclusa: ${formatarMoeda(
        totalFinal
      )}. Você pode parcelar ou pagar à vista no crédito/débito.`;
    }
    const linkMp = document.getElementById("linkCheckoutMercadoPago");
    if (linkMp) {
      linkMp.href = "https://www.mercadopago.com.br/";
    }
  }

  function abrirModalPagamentoCheckout() {
    const overlayCarrinho = document.getElementById("carrinhoOverlay");
    if (overlayCarrinho) {
      overlayCarrinho.classList.remove("aberto");
      overlayCarrinho.setAttribute("aria-hidden", "true");
    }

    const modalPag = document.getElementById("modalPagamentoCheckout");
    if (!modalPag) return;

    alternarAbaModalPagamento(estado.metodoPagamentoSelecionado || "pix");
    modalPag.classList.add("aberto");
    modalPag.setAttribute("aria-hidden", "false");
  }

  function fecharModalPagamentoCheckout() {
    const modalPag = document.getElementById("modalPagamentoCheckout");
    if (!modalPag) return;
    modalPag.classList.remove("aberto");
    modalPag.setAttribute("aria-hidden", "true");
  }

  function confirmarPagamentoRealizado() {
    if (estado.carrinho.length === 0) return;
    fecharModalPagamentoCheckout();
    limparCarrinho();
    mostrarToast(
      "✅ Compra registrada com sucesso! Estamos preparando seu pedido. Se tiver qualquer dúvida, chame no ícone do WhatsApp."
    );
  }

  // ==========================================================================
  // 5. AVALIAÇÕES DOS CLIENTES E GALERIA DE FOTOS DO PRODUTO
  // ==========================================================================

  function carregarAvaliacoesLocais() {
    try {
      const bruto = localStorage.getItem(CHAVE_STORAGE_AVALIACOES);
      if (!bruto) return {};
      const lido = JSON.parse(bruto);
      return lido && typeof lido === "object" ? lido : {};
    } catch (_) {
      return {};
    }
  }

  function salvarAvaliacoesLocais() {
    try {
      localStorage.setItem(CHAVE_STORAGE_AVALIACOES, JSON.stringify(estado.avaliacoesPorProduto));
    } catch (_) {}
  }

  async function carregarAvaliacoesBanco() {
    if (!supabaseInstancia) return;
    try {
      const { data, error } = await supabaseInstancia
        .from("avaliacoes")
        .select("id, produto_id, cliente_nome, nota, comentario, criado_em")
        .order("criado_em", { ascending: false });
      if (error) throw error;
      if (Array.isArray(data)) {
        const mapa = carregarAvaliacoesLocais();
        data.forEach((av) => {
          const pid = String(av.produto_id);
          if (!Array.isArray(mapa[pid])) mapa[pid] = [];
          if (!mapa[pid].some((existente) => String(existente.id) === String(av.id))) {
            mapa[pid].push(av);
          }
        });
        estado.avaliacoesPorProduto = mapa;
        salvarAvaliacoesLocais();
      }
    } catch (_) {
      // Se a tabela avaliacoes ainda não existir no banco, usa o armazenamento local normalmente
    }
  }

  function obterResumoAvaliacoesProduto(produtoId) {
    const lista = estado.avaliacoesPorProduto[String(produtoId)] || [];
    if (!Array.isArray(lista) || lista.length === 0) {
      return { total: 0, media: 0, mediaFormatada: "5,0", lista: [] };
    }
    const soma = lista.reduce((acc, a) => acc + (Number(a.nota) || 5), 0);
    const media = soma / lista.length;
    return {
      total: lista.length,
      media,
      mediaFormatada: media.toFixed(1).replace(".", ","),
      lista
    };
  }

  function abrirModalAvaliacoesProduto(produto) {
    if (!produto) return;
    estado.produtoModalAvaliacaoAtual = produto;

    const modal = document.getElementById("modalAvaliacoesProduto");
    if (!modal) return;

    const titulo = document.getElementById("tituloModalAvaliacoes");
    const preco = document.getElementById("precoProdutoModalDetalhe");
    const desc = document.getElementById("descricaoProdutoModalDetalhe");
    const imgPrincipal = document.getElementById("fotoPrincipalModalDetalhe");
    const containerMiniaturas = document.getElementById("miniaturasModalDetalhe");

    if (titulo) titulo.textContent = produto.nome || "Detalhes do Produto";
    if (preco) preco.textContent = formatarMoeda(produto.preco_venda);
    if (desc) desc.textContent = produto.descricao || "";

    const fotos = obterListaFotosProduto(produto);
    if (imgPrincipal) {
      imgPrincipal.src = fotos[0];
      imgPrincipal.alt = produto.nome || "Foto do produto";
    }

    if (containerMiniaturas) {
      containerMiniaturas.textContent = "";
      if (fotos.length > 1) {
        fotos.forEach((urlFoto, idx) => {
          const btnMin = document.createElement("button");
          btnMin.type = "button";
          btnMin.className = "galeria-miniatura-btn" + (idx === 0 ? " ativa" : "");
          const imgMin = document.createElement("img");
          imgMin.src = urlFoto;
          imgMin.alt = `Foto ${idx + 1}`;
          btnMin.appendChild(imgMin);
          btnMin.addEventListener("click", () => {
            if (imgPrincipal) imgPrincipal.src = urlFoto;
            containerMiniaturas
              .querySelectorAll(".galeria-miniatura-btn")
              .forEach((b) => b.classList.remove("ativa"));
            btnMin.classList.add("ativa");
          });
          containerMiniaturas.appendChild(btnMin);
        });
      }
    }

    const inputNome = document.getElementById("avalClienteNome");
    if (inputNome && estado.clienteLogado?.nome && !inputNome.value) {
      inputNome.value = estado.clienteLogado.nome;
    }

    renderizarListaAvaliacoesModal(produto.id);
    modal.classList.add("aberto");
    modal.setAttribute("aria-hidden", "false");
  }

  function fecharModalAvaliacoesProduto() {
    const modal = document.getElementById("modalAvaliacoesProduto");
    if (!modal) return;
    modal.classList.remove("aberto");
    modal.setAttribute("aria-hidden", "true");
  }

  function renderizarListaAvaliacoesModal(produtoId) {
    const resumoTopo = document.getElementById("resumoEstrelasModal");
    const containerLista = document.getElementById("listaAvaliacoesModal");
    const resumo = obterResumoAvaliacoesProduto(produtoId);

    if (resumoTopo) {
      resumoTopo.textContent =
        resumo.total > 0
          ? `⭐ Nota média: ${resumo.mediaFormatada} de 5 (${resumo.total} ${
              resumo.total === 1 ? "avaliação de cliente" : "avaliações de clientes"
            })`
          : "⭐ Este produto ainda não tem avaliações. Seja o primeiro a avaliar abaixo!";
    }

    if (!containerLista) return;
    containerLista.textContent = "";

    resumo.lista.forEach((av) => {
      const item = document.createElement("div");
      item.className = "item-avaliacao-cliente";

      const cab = document.createElement("div");
      cab.className = "item-avaliacao-cabecalho";

      const spNome = document.createElement("span");
      spNome.className = "item-avaliacao-nome";
      spNome.textContent = av.cliente_nome || "Cliente";

      const spEstrelas = document.createElement("span");
      spEstrelas.className = "item-avaliacao-estrelas";
      const qtdEstrelas = Math.min(5, Math.max(1, parseInt(av.nota, 10) || 5));
      spEstrelas.textContent = "⭐".repeat(qtdEstrelas);

      cab.appendChild(spNome);
      cab.appendChild(spEstrelas);
      item.appendChild(cab);

      const pCom = document.createElement("p");
      pCom.className = "item-avaliacao-comentario";
      pCom.textContent = av.comentario || "";
      item.appendChild(pCom);

      containerLista.appendChild(item);
    });
  }

  async function enviarAvaliacaoProdutoSubmit(evento) {
    evento.preventDefault();
    const produto = estado.produtoModalAvaliacaoAtual;
    if (!produto) return;

    const nome = String(document.getElementById("avalClienteNome")?.value || "").trim();
    const nota = parseInt(document.getElementById("avalNota")?.value || "5", 10) || 5;
    const comentario = String(document.getElementById("avalComentario")?.value || "").trim();

    if (nome.length < 2 || comentario.length < 2) {
      mostrarToast("Informe seu nome e escreva seu comentário para enviar a avaliação.");
      return;
    }

    const novaAval = {
      id: "aval-" + Date.now(),
      produto_id: produto.id,
      cliente_nome: nome,
      nota: Math.min(5, Math.max(1, nota)),
      comentario,
      criado_em: new Date().toISOString()
    };

    if (supabaseInstancia) {
      try {
        const { data, error } = await supabaseInstancia
          .from("avaliacoes")
          .insert([
            {
              produto_id: produto.id,
              cliente_nome: nome,
              nota: novaAval.nota,
              comentario
            }
          ])
          .select()
          .single();
        if (!error && data) {
          novaAval.id = data.id;
        }
      } catch (_) {}
    }

    const pid = String(produto.id);
    if (!Array.isArray(estado.avaliacoesPorProduto[pid])) {
      estado.avaliacoesPorProduto[pid] = [];
    }
    estado.avaliacoesPorProduto[pid].unshift(novaAval);
    salvarAvaliacoesLocais();

    const campoCom = document.getElementById("avalComentario");
    if (campoCom) campoCom.value = "";

    renderizarListaAvaliacoesModal(produto.id);
    renderizarVitrine();
    mostrarToast("⭐ Obrigado! Sua avaliação foi publicada no produto.");
  }

  // ==========================================================================
  // 6. EVENTOS DE INTERFACE (MENU, BUSCA, DRAWER E TOAST)
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
    }, 3200);
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

    if (btnFinalizar) btnFinalizar.addEventListener("click", iniciarFinalizacaoCompraSite);

    document.getElementById("selectAreaEntrega")?.addEventListener("change", (e) => {
      estado.areaEntregaSelecionada = e.target.value;
      salvarAreaEntrega();
      atualizarInterfaceCarrinho();
    });

    // Seletores de País, Estado, Cidade e Bairro do Calculador Sincronizado de Entrega no Carrinho
    const atualizarLocalizacaoCarrinho = () => {
      estado.localizacaoEntrega = {
        pais: document.getElementById("carrinhoCalcPais")?.value || "Brasil",
        estado: document.getElementById("carrinhoCalcEstado")?.value || "BA",
        cidade: document.getElementById("carrinhoCalcCidade")?.value || "Salvador",
        bairro: document.getElementById("carrinhoCalcBairro")?.value || ""
      };
      salvarLocalizacaoEntrega();
      atualizarInterfaceCarrinho();
    };
    document
      .getElementById("carrinhoCalcPais")
      ?.addEventListener("change", atualizarLocalizacaoCarrinho);
    document
      .getElementById("carrinhoCalcEstado")
      ?.addEventListener("change", atualizarLocalizacaoCarrinho);
    document
      .getElementById("carrinhoCalcCidade")
      ?.addEventListener("change", atualizarLocalizacaoCarrinho);
    document
      .getElementById("carrinhoCalcBairro")
      ?.addEventListener("change", atualizarLocalizacaoCarrinho);

    document.getElementById("selectMetodoPagamentoCarrinho")?.addEventListener("change", (e) => {
      estado.metodoPagamentoSelecionado = e.target.value;
      salvarMetodoPagamento();
      atualizarInterfaceCarrinho();
    });

    if (btnLimpar) btnLimpar.addEventListener("click", limparCarrinho);

    // Modal de Pagamento Mercado Pago
    const modalPag = document.getElementById("modalPagamentoCheckout");
    document
      .getElementById("btnFecharModalPagamento")
      ?.addEventListener("click", fecharModalPagamentoCheckout);
    modalPag?.addEventListener("click", (e) => {
      if (e.target === modalPag) fecharModalPagamentoCheckout();
    });
    document
      .getElementById("abaPagBtnPix")
      ?.addEventListener("click", () => alternarAbaModalPagamento("pix"));
    document
      .getElementById("abaPagBtnCartao")
      ?.addEventListener("click", () => alternarAbaModalPagamento("cartao"));
    document.getElementById("btnCopiarCodigoPix")?.addEventListener("click", () => {
      const inputPix = document.getElementById("inputPixCopiaECola");
      if (!inputPix) return;
      navigator.clipboard?.writeText(inputPix.value).catch(() => {
        inputPix.select();
        document.execCommand("copy");
      });
      mostrarToast("💠 Código Pix Copia e Cola copiado!");
    });
    document
      .getElementById("btnConfirmarPagamentoRealizado")
      ?.addEventListener("click", confirmarPagamentoRealizado);

    // Modal de Avaliações e Fotos do Produto
    const modalAval = document.getElementById("modalAvaliacoesProduto");
    document
      .getElementById("btnFecharModalAvaliacoes")
      ?.addEventListener("click", fecharModalAvaliacoesProduto);
    modalAval?.addEventListener("click", (e) => {
      if (e.target === modalAval) fecharModalAvaliacoesProduto();
    });
    document
      .getElementById("formAvaliacaoProduto")
      ?.addEventListener("submit", enviarAvaliacaoProdutoSubmit);

    // Campos de Cidade e Bairro personalizados no Cadastro de Cliente
    document.getElementById("cadClienteCidade")?.addEventListener("change", (e) => {
      const boxOutra = document.getElementById("campoCidadePersonalizadaWrap");
      if (boxOutra) boxOutra.style.display = e.target.value === "__outra__" ? "block" : "none";
    });
    document.getElementById("cadClienteBairro")?.addEventListener("change", (e) => {
      const boxOutro = document.getElementById("campoBairroPersonalizadoWrap");
      if (boxOutro) boxOutro.style.display = e.target.value === "__outro__" ? "block" : "none";
    });

    // Salvar data de nascimento no painel logado (para clientes antigos comprarem +18)
    document.getElementById("btnSalvarDataNascLogado")?.addEventListener("click", async () => {
      const novaData = String(document.getElementById("perfilInputDataNasc")?.value || "").trim();
      if (!novaData || calcularIdadeAnos(novaData) === null) {
        mostrarToast("Informe uma data de nascimento válida.");
        return;
      }
      if (estado.clienteLogado) {
        estado.clienteLogado.data_nascimento = novaData;
        salvarClienteLogado(estado.clienteLogado);
        if (supabaseInstancia && estado.clienteLogado.email) {
          try {
            await supabaseInstancia.rpc("atualizar_data_nascimento_cliente", {
              p_email: estado.clienteLogado.email,
              p_data_nascimento: novaData
            });
          } catch (_) {}
        }
        mostrarToast("Data de nascimento salva no seu perfil!");
        executarAcaoPendentePosLogin();
      }
    });

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

    popularSelectBairrosCadastroCliente();

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

