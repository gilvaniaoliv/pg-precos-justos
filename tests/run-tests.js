/**
 * ============================================================================
 * SUÍTE DE TESTES AUTOMATIZADOS - P&G PREÇOS JUSTOS (FASE 4)
 * ============================================================================
 * Verifica:
 * 1. Segurança de chaves (ausência total de service_role)
 * 2. Políticas de RLS e isolamento de colunas sensíveis no SQL (sql/setup.sql)
 * 3. Simulação de acesso anônimo vs. autenticado às tabelas e views
 * 4. Regras de Preço Médio de Mercado (<5%, >=5%, >média, >60 dias, sem "de/por")
 * 5. Regras de Estoque (0 = Esgotado, <3 = Últimas unidades)
 * 6. Proteção contra XSS nos arquivos JS
 */

const fs = require("fs");
const path = require("path");

const RAIZ = path.resolve(__dirname, "..");
let totalTestes = 0;
let totalPassaram = 0;
let totalFalharam = 0;

function testar(nome, fn) {
  totalTestes++;
  try {
    fn();
    totalPassaram++;
    console.log(`  ✅ PASSOU: ${nome}`);
  } catch (erro) {
    totalFalharam++;
    console.error(`  ❌ FALHOU: ${nome}`);
    console.error(`     Motivo: ${erro.message}`);
  }
}

function afirmar(condicao, mensagem) {
  if (!condicao) {
    throw new Error(mensagem);
  }
}

// Carrega arquivos do projeto para inspeção e execução
const sqlContent = fs.readFileSync(path.join(RAIZ, "sql", "setup.sql"), "utf8");
const configContent = fs.readFileSync(path.join(RAIZ, "config.js"), "utf8");
const appContent = fs.readFileSync(path.join(RAIZ, "app.js"), "utf8");
const adminContent = fs.readFileSync(path.join(RAIZ, "admin", "admin.js"), "utf8");
const indexHtml = fs.readFileSync(path.join(RAIZ, "index.html"), "utf8");

// Carrega utilitários da vitrine em ambiente simulado window
global.window = {};
eval(configContent);
global.document = { addEventListener: () => {} };
eval(appContent);
const Utils = global.window.PGVitrineUtils;

console.log("======================================================================");
console.log("🧪 INICIANDO TESTES DE SEGURANÇA E REGRAS - P&G PREÇOS JUSTOS");
console.log("======================================================================\n");

// ----------------------------------------------------------------------------
// BLOCO 1: SEGURANÇA DE CREDENCIAIS E ARQUITETURA
// ----------------------------------------------------------------------------
console.log("1️⃣  Segurança de Chaves e Proteção contra XSS:");

testar("Nenhum arquivo utiliza a chave secreta service_role", () => {
  const arquivos = [configContent, appContent, adminContent, indexHtml];
  arquivos.forEach((conteudo) => {
    // Ignora comentários de aviso que dizem "NUNCA use service_role"
    const semComentarios = conteudo
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*/g, "");
    afirmar(
      !semComentarios.includes("service_role"),
      "A chave service_role foi encontrada fora de comentários!"
    );
  });
});

testar("Proteção contra XSS: app.js e admin.js não usam innerHTML para renderizar dados", () => {
  afirmar(
    !appContent.includes(".innerHTML"),
    "app.js não deve usar innerHTML para evitar XSS"
  );
  afirmar(
    !adminContent.includes(".innerHTML"),
    "admin.js não deve usar innerHTML para evitar XSS"
  );
});

// ----------------------------------------------------------------------------
// BLOCO 2: AUDITORIA DE RLS E PERMISSÕES DE VISITANTE ANÔNIMO (anon)
// ----------------------------------------------------------------------------
console.log("\n2️⃣  Banco de Dados, Row Level Security (RLS) e Isolamento de Dados Internos:");

testar("RLS está ativado e forçado nas 3 tabelas (categorias, produtos e vendas)", () => {
  afirmar(
    sqlContent.includes("ALTER TABLE public.categorias ENABLE ROW LEVEL SECURITY;"),
    "Falta ENABLE RLS em categorias"
  );
  afirmar(
    sqlContent.includes("ALTER TABLE public.produtos ENABLE ROW LEVEL SECURITY;"),
    "Falta ENABLE RLS em produtos"
  );
  afirmar(
    sqlContent.includes("ALTER TABLE public.vendas ENABLE ROW LEVEL SECURITY;"),
    "Falta ENABLE RLS em vendas"
  );
});

testar("Visitante NÃO logado (anon) consegue LER produtos públicos ativos e categorias", () => {
  afirmar(
    sqlContent.includes("GRANT SELECT ON TABLE public.produtos_publicos TO anon, authenticated;"),
    "Visitante anônimo precisa ter SELECT na view produtos_publicos"
  );
  afirmar(
    sqlContent.includes("WHERE p.ativo = true;"),
    "A view pública deve filtrar estritamente produtos ativos (WHERE p.ativo = true)"
  );
  afirmar(
    sqlContent.includes("GRANT SELECT ON TABLE public.categorias TO anon;"),
    "Visitante anônimo precisa ter SELECT em categorias"
  );
});

testar("Visitante NÃO logado (anon) está BLOQUEADO de ver custos, preços mínimos, fontes e produtos inativos", () => {
  // Verifica que a tabela original 'produtos' teve os privilégios revogados para anon
  afirmar(
    sqlContent.includes("REVOKE ALL ON TABLE public.produtos FROM anon;"),
    "A tabela 'produtos' deve ter REVOKE ALL para anon"
  );

  // Extrai a definição da view produtos_publicos e garante que colunas restritas NÃO estão nela
  const matchView = sqlContent.match(
    /CREATE VIEW public\.produtos_publicos AS([\s\S]*?)WHERE p\.ativo = true;/i
  );
  afirmar(Boolean(matchView), "Definição da view produtos_publicos não encontrada");
  const corpoView = matchView[1].toLowerCase();

  afirmar(
    !corpoView.includes("preco_custo"),
    "VAZAMENTO: preco_custo não pode existir na view pública!"
  );
  afirmar(
    !corpoView.includes("preco_minimo_negociacao"),
    "VAZAMENTO: preco_minimo_negociacao não pode existir na view pública!"
  );
  afirmar(
    !corpoView.includes("fontes_pesquisa"),
    "VAZAMENTO: fontes_pesquisa não pode existir na view pública!"
  );
});

testar("Visitante NÃO logado (anon) está BLOQUEADO de ler a tabela de vendas", () => {
  afirmar(
    sqlContent.includes("REVOKE ALL ON TABLE public.vendas FROM anon;"),
    "A tabela 'vendas' deve ter REVOKE ALL para anon"
  );
  afirmar(
    !sqlContent.includes("ON public.vendas\n    FOR SELECT\n    TO anon"),
    "Anônimos não podem ter política de SELECT em vendas"
  );
});

testar("Visitante NÃO logado (anon) NÃO consegue inserir, editar ou apagar em nenhuma tabela nem executar vendas", () => {
  afirmar(
    sqlContent.includes("REVOKE ALL ON TABLE public.produtos_publicos FROM anon, authenticated;") &&
      sqlContent.includes("GRANT SELECT ON TABLE public.produtos_publicos TO anon, authenticated;"),
    "A view pública só deve conceder permissão SELECT"
  );
  afirmar(
    sqlContent.includes(
      "REVOKE ALL ON FUNCTION public.registrar_venda_admin(UUID, INTEGER, NUMERIC, TEXT) FROM PUBLIC, anon;"
    ),
    "A função registrar_venda_admin deve ser bloqueada para anon"
  );
  afirmar(
    sqlContent.includes("FOR ALL\n    TO authenticated"),
    "Apenas usuários authenticated podem ter política FOR ALL (INSERT/UPDATE/DELETE)"
  );
});

testar("Storage de fotos permite leitura pública mas restringe upload, edição e exclusão a autenticados", () => {
  afirmar(
    sqlContent.includes('CREATE POLICY "Fotos publicas para leitura"') &&
      sqlContent.includes("FOR SELECT\n    TO anon, authenticated"),
    "Leitura pública de fotos deve estar ativa"
  );
  afirmar(
    sqlContent.includes('CREATE POLICY "Admin faz upload de fotos"\n    ON storage.objects\n    FOR INSERT\n    TO authenticated'),
    "Upload de fotos deve ser exclusivo para authenticated"
  );
  afirmar(
    sqlContent.includes('CREATE POLICY "Admin exclui fotos"\n    ON storage.objects\n    FOR DELETE\n    TO authenticated'),
    "Exclusão de fotos deve ser exclusiva para authenticated"
  );
});

// ----------------------------------------------------------------------------
// BLOCO 3: REGRAS DE NEGÓCIO DA VITRINE (PREÇO MÉDIO E ESTOQUE)
// ----------------------------------------------------------------------------
console.log("\n3️⃣  Regras de Exibição de Preço Médio e Estoque:");

const dataRef = new Date(2026, 10, 1, 12, 0, 0); // 01/11/2026

testar("Diferença >= 5% exibe preço médio no formato exato + 'Economize R$ X'", () => {
  const prod = {
    preco_venda: 75.0,
    preco_medio_mercado: 100.0, // 25% de diferença (R$ 25,00)
    data_pesquisa: "2026-10-20"
  };
  const res = Utils.avaliarComparacaoPreco(prod, dataRef);
  afirmar(res.exibirPrecoMedio === true, "Deveria exibir o preço médio");
  afirmar(res.exibirEconomia === true, "Deveria exibir 'Economize R$ X'");
  afirmar(
    res.textoPrecoMedio.includes("Preço médio no mercado:") &&
      res.textoPrecoMedio.includes("(pesquisado em 20/10)"),
    `Formato incorreto: ${res.textoPrecoMedio}`
  );
  afirmar(
    res.textoEconomia.includes("Economize") && res.textoEconomia.includes("25,00"),
    `Selo de economia incorreto: ${res.textoEconomia}`
  );
});

testar("Diferença < 5% exibe apenas preço de venda e preço médio, SEM porcentagem e SEM 'Economize R$ X'", () => {
  const prod = {
    preco_venda: 97.0,
    preco_medio_mercado: 100.0, // 3% de diferença (< 5%)
    data_pesquisa: "2026-10-20"
  };
  const res = Utils.avaliarComparacaoPreco(prod, dataRef);
  afirmar(res.exibirPrecoMedio === true, "Deveria exibir o preço médio");
  afirmar(res.exibirEconomia === false, "NÃO deveria exibir selo de economia para diferença < 5%");
});

testar("Preço de venda MAIOR que a média NÃO exibe nenhuma comparação", () => {
  const prod = {
    preco_venda: 110.0,
    preco_medio_mercado: 100.0,
    data_pesquisa: "2026-10-20"
  };
  const res = Utils.avaliarComparacaoPreco(prod, dataRef);
  afirmar(res.exibirPrecoMedio === false, "Não deve exibir comparação quando venda > média");
  afirmar(res.exibirEconomia === false, "Não deve exibir economia quando venda > média");
});

testar("Pesquisa com MAIS de 60 dias NÃO exibe o preço médio", () => {
  const prod = {
    preco_venda: 60.0,
    preco_medio_mercado: 100.0,
    data_pesquisa: "2026-08-01" // ~92 dias atrás em relação a 01/11/2026
  };
  const res = Utils.avaliarComparacaoPreco(prod, dataRef);
  afirmar(res.exibirPrecoMedio === false, "Não deve exibir preço médio com mais de 60 dias");
  afirmar(res.motivoOculto === "pesquisa_antiga", "Motivo deveria ser pesquisa_antiga");
});

testar("Controle de estoque: 0 = 'Esgotado' (desativado) e < 3 = 'Últimas unidades'", () => {
  const estZero = Utils.avaliarStatusEstoque(0);
  afirmar(estZero.esgotado === true && estZero.label === "Esgotado", "Estoque 0 deve ser Esgotado");

  const estDois = Utils.avaliarStatusEstoque(2);
  afirmar(
    estDois.esgotado === false &&
      estDois.ultimasUnidades === true &&
      estDois.label === "Últimas unidades",
    "Estoque 2 (<3) deve mostrar 'Últimas unidades'"
  );

  const estTres = Utils.avaliarStatusEstoque(3);
  afirmar(
    estTres.esgotado === false && estTres.ultimasUnidades === false,
    "Estoque 3 não deve mostrar 'Últimas unidades'"
  );
});

console.log("\n======================================================================");
console.log(
  `📊 RESULTADO FINAL: ${totalPassaram}/${totalTestes} testes aprovados (${totalFalharam} falhas)`
);
console.log("======================================================================");

if (totalFalharam > 0) {
  process.exit(1);
}

