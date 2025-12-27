/**
 * Bank POS URL Constants
 * Her banka icin test ve production URL'leri
 */

export const BANK_URLS = {
  // ============================================
  // YAPI KREDI (POSNET)
  // ============================================
  ykb: {
    test: {
      api: 'https://setmpos.ykb.com/PosnetWebService/XML',
      gate: 'https://setmpos.ykb.com/3DSWebService/YKBPaymentService'
    },
    production: {
      api: 'https://posnet.yapikredi.com.tr/PosnetWebService/XML',
      gate: 'https://posnet.yapikredi.com.tr/3DSWebService/YKBPaymentService'
    }
  },

  // ============================================
  // GARANTI BBVA
  // ============================================
  garanti: {
    test: {
      api: 'https://sanalposprovtest.garanti.com.tr/VPServlet',
      gate: 'https://sanalposprovtest.garanti.com.tr/servlet/gt3dengine'
    },
    production: {
      api: 'https://sanalposprov.garanti.com.tr/VPServlet',
      gate: 'https://sanalposprov.garanti.com.tr/servlet/gt3dengine'
    }
  },

  // ============================================
  // AKBANK
  // ============================================
  akbank: {
    test: {
      api: 'https://www.sanalakpos.com/fim/api',
      gate: 'https://www.sanalakpos.com/fim/est3Dgate'
    },
    production: {
      api: 'https://www.sanalakpos.com/fim/api',
      gate: 'https://www.sanalakpos.com/fim/est3Dgate'
    }
  },

  // ============================================
  // IS BANKASI (PAYTEN/NESTPAY)
  // ============================================
  isbank: {
    test: {
      api: 'https://entegrasyon.asseco-see.com.tr/fim/api',
      gate: 'https://entegrasyon.asseco-see.com.tr/fim/est3Dgate'
    },
    production: {
      api: 'https://spos.isbank.com.tr/fim/api',
      gate: 'https://spos.isbank.com.tr/fim/est3Dgate'
    }
  },

  // ============================================
  // VAKIFBANK
  // ============================================
  vakifbank: {
    test: {
      api: 'https://onlineodemetest.vakifbank.com.tr:4443/VposService/v3/Vposreq.aspx',
      gate: 'https://3dsecuretest.vakifbank.com.tr:4443/MPIAPI/MPI_Enrollment.aspx'
    },
    production: {
      api: 'https://onlineodeme.vakifbank.com.tr:4443/VposService/v3/Vposreq.aspx',
      gate: 'https://3dsecure.vakifbank.com.tr:4443/MPIAPI/MPI_Enrollment.aspx'
    }
  },

  // ============================================
  // QNB FINANSBANK
  // ============================================
  qnb: {
    test: {
      api: 'https://vpostest.qnbfinansbank.com/Gateway/Default.aspx',
      gate: 'https://vpostest.qnbfinansbank.com/Gateway/3DHost.aspx'
    },
    production: {
      api: 'https://vpos.qnbfinansbank.com/Gateway/Default.aspx',
      gate: 'https://vpos.qnbfinansbank.com/Gateway/3DHost.aspx'
    }
  },

  // ============================================
  // HALKBANK (PAYTEN/NESTPAY)
  // ============================================
  halkbank: {
    test: {
      api: 'https://entegrasyon.asseco-see.com.tr/fim/api',
      gate: 'https://entegrasyon.asseco-see.com.tr/fim/est3Dgate'
    },
    production: {
      api: 'https://sanalpos.halkbank.com.tr/fim/api',
      gate: 'https://sanalpos.halkbank.com.tr/fim/est3Dgate'
    }
  },

  // ============================================
  // ZIRAAT BANKASI (PAYTEN/NESTPAY)
  // ============================================
  ziraat: {
    test: {
      api: 'https://entegrasyon.asseco-see.com.tr/fim/api',
      gate: 'https://entegrasyon.asseco-see.com.tr/fim/est3Dgate'
    },
    production: {
      api: 'https://sanalpos2.ziraatbank.com.tr/fim/api',
      gate: 'https://sanalpos2.ziraatbank.com.tr/fim/est3Dgate'
    }
  },

  // ============================================
  // TEB (PAYTEN/NESTPAY)
  // ============================================
  teb: {
    test: {
      api: 'https://entegrasyon.asseco-see.com.tr/fim/api',
      gate: 'https://entegrasyon.asseco-see.com.tr/fim/est3Dgate'
    },
    production: {
      api: 'https://sanalpos.teb.com.tr/fim/api',
      gate: 'https://sanalpos.teb.com.tr/fim/est3Dgate'
    }
  },

  // ============================================
  // DENIZBANK
  // ============================================
  denizbank: {
    test: {
      api: 'https://inter-vpos.com.tr/mpi/Default.aspx',
      gate: 'https://inter-vpos.com.tr/mpi/3DHost.aspx'
    },
    production: {
      api: 'https://inter-vpos.com.tr/mpi/Default.aspx',
      gate: 'https://inter-vpos.com.tr/mpi/3DHost.aspx'
    }
  },

  // ============================================
  // ING BANK (PAYTEN/NESTPAY)
  // ============================================
  ingbank: {
    test: {
      api: 'https://entegrasyon.asseco-see.com.tr/fim/api',
      gate: 'https://entegrasyon.asseco-see.com.tr/fim/est3Dgate'
    },
    production: {
      api: 'https://sanalpos.ingbank.com.tr/fim/api',
      gate: 'https://sanalpos.ingbank.com.tr/fim/est3Dgate'
    }
  },

  // ============================================
  // SEKERBANK (PAYTEN/NESTPAY)
  // ============================================
  sekerbank: {
    test: {
      api: 'https://entegrasyon.asseco-see.com.tr/fim/api',
      gate: 'https://entegrasyon.asseco-see.com.tr/fim/est3Dgate'
    },
    production: {
      api: 'https://sanalpos.sekerbank.com.tr/fim/api',
      gate: 'https://sanalpos.sekerbank.com.tr/fim/est3Dgate'
    }
  },

  // ============================================
  // KUVEYT TURK
  // ============================================
  kuveytturk: {
    test: {
      api: 'https://boatest.kuveytturk.com.tr/boa.virtualpos.services/Home/ThreeDModelPayGate',
      gate: 'https://boatest.kuveytturk.com.tr/boa.virtualpos.services/Home/ThreeDModelProvisionGate'
    },
    production: {
      api: 'https://boa.kuveytturk.com.tr/sanalposservice/Home/ThreeDModelPayGate',
      gate: 'https://boa.kuveytturk.com.tr/sanalposservice/Home/ThreeDModelProvisionGate'
    }
  }
};

/**
 * Get bank URLs based on testMode
 */
export function getBankUrls(bankCode, testMode = false) {
  const bankUrls = BANK_URLS[bankCode];
  if (!bankUrls) {
    return null;
  }
  return testMode ? bankUrls.test : bankUrls.production;
}

export default BANK_URLS;
